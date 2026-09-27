import { sessionAuditStatement } from './audit.js';

const COOKIE = '__Host-cloudmail_session';
const MAX_AGE = 12 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export async function secretHash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function csrfForToken(token) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('cloud-mail csrf v1')));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function sessionCookie(token) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('INVALID_SESSION_TOKEN');
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

export function expiredSessionCookie() {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function cookieToken(request) {
  const values = (request.headers.get('Cookie') || '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  return TOKEN_PATTERN.test(token) ? token : null;
}

export async function createSession(db, user, accessSub) {
  if (typeof accessSub !== 'string' || !accessSub || accessSub.length > 512) throw new Error('ACCESS_IDENTITY_REQUIRED');
  const token = randomToken();
  const csrfToken = await csrfForToken(token);
  const now = Date.now();
  const expiresAt = now + MAX_AGE * 1000;
  const [tokenHash, csrfHash, credentialFingerprint] = await Promise.all([
    secretHash(token), secretHash(csrfToken), secretHash(user.password),
  ]);
  // The insert and fresh user/credential check are one statement, avoiding a login/disable race.
  const results = await db.batch([db.prepare(`INSERT INTO sessions
    (token_hash,user_id,access_sub,csrf_hash,credential_fingerprint,created_at,expires_at)
    SELECT ?,user_id,?,?,?,?,? FROM user
    WHERE user_id=? AND status=0 AND is_del=0 AND retired_at IS NULL AND password=?`)
    .bind(tokenHash, accessSub, csrfHash, credentialFingerprint, now, expiresAt, user.userId, user.password),
    sessionAuditStatement(db, tokenHash, 'auth.login', 'SUCCESS'),
  ]);
  if (results[0].meta.changes !== 1) throw new Error('SESSION_USER_UNAVAILABLE');
  return { token, csrfToken, tokenHash, expiresAt, cookie: sessionCookie(token) };
}

export async function readSession(db, request, accessSub) {
  const token = cookieToken(request);
  if (!token || typeof accessSub !== 'string' || !accessSub) return null;
  const tokenHash = await secretHash(token);
  const row = await db.prepare(`SELECT s.csrf_hash,s.credential_fingerprint,s.expires_at,
    u.user_id,u.email,u.type,u.status,u.is_del,u.password
    FROM sessions s JOIN user u ON u.user_id=s.user_id
    WHERE s.token_hash=? AND s.access_sub=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND u.status=0 AND u.is_del=0 AND u.retired_at IS NULL`)
    .bind(tokenHash, accessSub, Date.now()).first();
  if (!row || await secretHash(row.password) !== row.credential_fingerprint) return null;
  return {
    tokenHash, csrfHash: row.csrf_hash, csrfToken: await csrfForToken(token), expiresAt: row.expires_at,
    user: { userId: row.user_id, email: row.email, type: row.type, status: row.status, isDel: row.is_del },
  };
}

export async function revokeSession(db, tokenHash, reason = 'LOGOUT') {
  await db.batch([
    sessionAuditStatement(db, tokenHash, 'auth.session.revoked', reason),
    db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(Date.now(), tokenHash),
  ]);
}

export async function revokeUserSessions(db, userId) {
  await db.batch([
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT DISTINCT NULL,'auth.session.revoked',CAST(user_id AS TEXT),'USER_RESET',? FROM sessions
      WHERE user_id=? AND revoked_at IS NULL`).bind(Date.now(), userId),
    db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(), userId),
  ]);
}
