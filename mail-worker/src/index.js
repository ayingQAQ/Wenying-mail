import app from './hono/webs';
import { verifyApplicationEntry } from './security/application-auth.js';
import { maintainSecurity } from './security/maintenance.js';
import { RETIRED_API_PATHS } from './security/receive-only.js';
import { consumeMailQueue } from './processing/queue-handler.js';
import { recoverMail } from './processing/recovery.js';
import { persistDeletionTombstones,expireTrash } from './service/mail-deletion.js';
import { purgeMail } from './processing/purge.js';
import { collectOldGenerations } from './processing/generation-gc.js';
import { sweepRetiredMail } from './service/retire-identity.js';
import { backupHold } from './processing/backup-hold.js';
import {advanceBulkDeletion} from './service/mail-operations.js';
import {proxyVps} from './runtime/vps-proxy.js';
import {emailLogin,EMAIL_LOGIN_PATHS} from './security/email-login.js';

const retiredRoutes = [
	'/attachments', '/static', ...RETIRED_API_PATHS.map(path => '/api' + path),
];
export default {
	queue: consumeMailQueue,
	 async fetch(req, env, ctx) {
		if(new URL(req.url).pathname==='/ops/backup/hold') return backupHold(req,env);
		const access = await verifyApplicationEntry(req, env);
		if (access.response) return access.response;

		const url = new URL(req.url)
		if (retiredRoutes.some(path => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
			return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
		}

		if (url.pathname.startsWith('/api/')) {
			if(env.VPS_API_ORIGIN)return proxyVps(req,env);
			if(EMAIL_LOGIN_PATHS.includes(url.pathname))return emailLogin(req,env);
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, { ...env, ACCESS_IDENTITY: access.identity }, ctx);
		}

		return env.assets.fetch(req);
	},
	async scheduled(c, env, ctx) {
		await maintainSecurity(env.db);
		await env.db.prepare("UPDATE backup_runs SET state='FAILED',error_code='HOLD_OR_RECEIPT_EXPIRED',completed_at=unixepoch()*1000 WHERE state IN ('RUNNING','COPIED') AND hold_until<=unixepoch()*1000").run();
		await env.db.prepare("DELETE FROM operations_events WHERE event_id IN (SELECT event_id FROM operations_events WHERE created_at<unixepoch()*1000-2592000000 LIMIT 100)").run();
		if (env.MAIL_RECOVERY_ENABLED === 'true') await recoverMail(env);
		if (env.MAIL_DELETION_ENABLED === 'true') {
			await advanceBulkDeletion(env.db);
			if (env.MAIL_TRASH_EXPIRY_ENABLED === 'true') await expireTrash(env.db);
			await sweepRetiredMail(env.db);
			await persistDeletionTombstones(env);
		}
		if (env.MAIL_PURGE_ENABLED === 'true') await purgeMail(env);
		if (env.MAIL_GENERATION_GC_ENABLED === 'true') await collectOldGenerations(env);
	},
};
