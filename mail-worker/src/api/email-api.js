import {readSession} from '../security/session.js';
import {sessionSubject} from '../security/application-auth.js';
import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import { mailDetail, mailBody, mailRaw, mailAttachment, privateHeaders } from '../service/private-mail.js';
import { changeMailFolder,listTrash } from '../service/mail-folders.js';
import { requestMailDeletion,deletionStatus } from '../service/mail-deletion.js';
import {mailStatistics} from '../service/mail-statistics.js';

app.get('/email/statistics',async c=>c.json(result.ok(await mailStatistics(c.env.db,userContext.getUserId(c))),200,privateHeaders));

app.get('/email/events',c=>{
 if(!c.env.MAIL_EVENTS)return c.json({code:'EVENTS_UNAVAILABLE'},503);
 const session=c.get('session');
 return c.env.MAIL_EVENTS.open({userId:session.user.userId,expiresAt:session.expiresAt,signal:c.req.raw.signal,
  verify:async()=>!!await readSession(c.env.db,c.req.raw,sessionSubject(c.env))});
});

app.get('/email/list', async (c) => {
	const data = await emailService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await emailService.latest(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = (await mailDetail(c.env,c.req.query('emailId'),userContext.getUserId(c))).attList;
	return c.json(result.ok(attList));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
})

// Static legacy routes above must precede the parameterized detail route.
app.get('/email/deletions',async c=>c.json(result.ok(await deletionStatus(c.env.db,userContext.getUserId(c))),200,privateHeaders));
app.get('/email/trash-policy',c=>c.json(result.ok({days:30,expirationEnabled:c.env.MAIL_DELETION_ENABLED==='true' && c.env.MAIL_TRASH_EXPIRY_ENABLED==='true'}),200,privateHeaders));
app.get('/email/trash',async c=>c.json(result.ok(await listTrash(c.env.db,userContext.getUserId(c),c.req.query())),200,privateHeaders));
app.post('/email/:id/trash',async c=>c.json(result.ok(await changeMailFolder(c.env.db,[c.req.param('id')],userContext.getUserId(c),'TRASH'))));
app.post('/email/:id/restore',async c=>c.json(result.ok(await changeMailFolder(c.env.db,[c.req.param('id')],userContext.getUserId(c),'INBOX'))));
app.delete('/email/:id/permanent',async c=>c.json(result.ok(await requestMailDeletion(c.env.db,[c.req.param('id')],userContext.getUserId(c))),202));
app.get('/email/:id', async c => c.json(result.ok(await mailDetail(c.env,c.req.param('id'),userContext.getUserId(c))),200,privateHeaders));
app.get('/email/:id/body', async c => c.json(result.ok(await mailBody(c.env,c.req.param('id'),userContext.getUserId(c),c.req.query('format') || 'html')),200,privateHeaders));
app.get('/email/:id/raw', async c => mailRaw(c.env,c.req.param('id'),userContext.getUserId(c)));
app.get('/attachment/:id', async c => mailAttachment(c.env,c.req.param('id'),userContext.getUserId(c)));
app.get('/attachment/:id/inline', async c => mailAttachment(c.env,c.req.param('id'),userContext.getUserId(c),true));

