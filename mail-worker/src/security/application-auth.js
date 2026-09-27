import { verifyAccess } from './access.js';

// This is a session namespace, never a user identity or an authentication proof.
// Password sessions still require a random cookie and a live, enabled DB user.
const PASSWORD_SESSION_NAMESPACE = 'cloudmail:password:v1';

export function sessionSubject(env) {
  return ['password','either'].includes(env.MAIL_AUTH_MODE)
    ? PASSWORD_SESSION_NAMESPACE : env.ACCESS_IDENTITY?.sub;
}

export async function verifyApplicationEntry(request, env) {
  if (env.MAIL_AUTH_MODE === undefined || env.MAIL_AUTH_MODE === 'access') return verifyAccess(request, env);
  const deny = (code, status) => ({ response: Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } }) });
  if (!['password','either'].includes(env.MAIL_AUTH_MODE)) return deny('AUTH_NOT_CONFIGURED', 503);
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { return deny('AUTH_NOT_CONFIGURED', 503); }
  if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN) return deny('AUTH_NOT_CONFIGURED', 503);
  if (new URL(request.url).origin !== origin.origin) return deny('ORIGIN_NOT_ALLOWED', 403);
  return {};
}
