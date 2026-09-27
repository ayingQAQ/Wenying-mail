import { readSession } from './session.js';
import { sessionSubject } from './application-auth.js';
import { validateMutation } from './csrf.js';
import { RETIRED_API_PATHS } from './receive-only.js';
import result from '../model/result.js';
import BizError from '../error/biz-error';
import permService from '../service/perm-service';
import { t } from '../i18n/i18n'
import app from '../hono/hono';



const requirePerms = [
	'/email/send',
	'/email/delete',
	'/account/list',
	'/account/delete',
	'/account/add',
	'/my/delete',
	'/analysis/echarts',
	'/role/add',
	'/role/list',
	'/role/delete',
	'/role/tree',
	'/role/set',
	'/role/setDefault',
	'/allEmail/list',
	'/allEmail/delete',
	'/allEmail/batchDelete',
	'/allEmail/latest',
	'/setting/setBackground',
	'/setting/deleteBackground',
	'/setting/set',
	'/setting/query',
	'/setting/setBlacklist',
	'/user/delete',
	'/user/setPwd',
	'/user/setStatus',
	'/user/setType',
	'/user/list',
	'/user/restore',
	'/user/resetSendCount',
	'/user/add',
	'/user/deleteAccount',
	'/user/allAccount',
	'/regKey/add',
	'/regKey/list',
	'/regKey/delete',
	'/regKey/clearNotUse',
	'/regKey/history'
];

const premKey = {
	'email:delete': ['/email/delete'],
	'email:send': ['/email/send'],
	'account:add': ['/account/add'],
	'account:query': ['/account/list'],
	'account:delete': ['/account/delete'],
	'my:delete': ['/my/delete'],
	'role:add': ['/role/add'],
	'role:set': ['/role/set','/role/setDefault'],
	'role:query': ['/role/list', '/role/tree'],
	'role:delete': ['/role/delete'],
	'user:query': ['/user/list','/user/allAccount'],
	'user:add': ['/user/add'],
	'user:reset-send': ['/user/resetSendCount'],
	'user:set-pwd': ['/user/setPwd'],
	'user:set-status': ['/user/setStatus', '/user/restore'],
	'user:set-type': ['/user/setType'],
	'user:delete': ['/user/delete','/user/deleteAccount'],
	'all-email:query': ['/allEmail/list','/allEmail/latest'],
	'all-email:delete': ['/allEmail/delete','/allEmail/batchDelete'],
	'setting:query': ['/setting/query'],
	'setting:set': ['/setting/set', '/setting/setBackground','/setting/deleteBackground','/setting/setBlacklist'],
	'analysis:query': ['/analysis/echarts'],
	'reg-key:add': ['/regKey/add'],
	'reg-key:query': ['/regKey/list','/regKey/history'],
	'reg-key:delete': ['/regKey/delete','/regKey/clearNotUse'],
};

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const path = c.req.path;
  if (RETIRED_API_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return c.json(result.fail('NOT_FOUND', 404), 404);
  const accessSub = sessionSubject(c.env);
  if (!accessSub) return c.json(result.fail('ACCESS_REQUIRED', 401), 401);
  const login = path === '/login' && c.req.method === 'POST';
  const session = login ? null : await readSession(c.env.db, c.req.raw, accessSub);
  const rejection = await validateMutation(c.req.raw, c.env.APP_ORIGIN, session, { login });
  if (rejection) return rejection;
  if (login) return next();
  if (path === '/setting/websiteConfig' && c.req.method === 'GET') {
    if (session) { c.set('session', session); c.set('user', session.user); }
    return next();
  }
  if (!session) return c.json(result.fail('SESSION_REQUIRED', 401), 401);
  c.set('session', session);
  c.set('user', session.user);
  if(path==='/mailOperations/mailboxes'||/^\/mailOperations\/mailboxes\/[^/]+$/.test(path)) {
    const admin=typeof c.env.admin==='string'&&session.user.email.toLowerCase()===c.env.admin.toLowerCase();
    const keys=await permService.userPermKeys(c,session.user.userId);
    if(!admin&&!keys.includes(c.req.method==='GET'?'account:query':'account:add'))throw new BizError('FORBIDDEN',403);
  }
  const folderMutation=(c.req.method==='POST' && /^\/email\/[^/]+\/(trash|restore)$/.test(path)) ||
    (c.req.method==='DELETE' && /^\/email\/[^/]+\/permanent$/.test(path));
  if (folderMutation || requirePerms.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
    const keys = await permService.userPermKeys(c, session.user.userId);
    const paths = permKeyToPaths(keys);
    const admin = typeof c.env.admin === 'string' && session.user.email.toLowerCase() === c.env.admin.toLowerCase();
    if (!admin && !(folderMutation ? keys.includes('email:delete'):paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))) throw new BizError(t('unauthorized'), 403);
  }
  return next();
});
function permKeyToPaths(permKeys) {

	const paths = [];

	for (const key of permKeys) {
		const routeList = premKey[key];
		if (routeList && Array.isArray(routeList)) {
			paths.push(...routeList);
		}
	}
	return paths;
}
