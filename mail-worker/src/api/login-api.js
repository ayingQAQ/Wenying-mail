import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import { expiredSessionCookie } from '../security/session.js';

app.post('/login', async (c) => {
	const session = await loginService.login(c, await c.req.json());
	c.header('Set-Cookie', session.cookie);
	return c.json(result.ok({ csrfToken: session.csrfToken, expiresAt: session.expiresAt }));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	c.header('Set-Cookie', expiredSessionCookie());
	return c.json(result.ok());
});

app.get('/session', (c) => {
	const session = c.get('session');
	return c.json(result.ok({ user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt }));
});

