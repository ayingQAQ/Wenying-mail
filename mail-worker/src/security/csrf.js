import { secretHash } from './session.js';
import { timingSafeEqual } from 'node:crypto';
const encoder = new TextEncoder();

function deny(code, status) {
  return Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function validateMutation(request, appOrigin, session, { login = false } = {}) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  if (!appOrigin || new URL(request.url).origin !== appOrigin || request.headers.get('Origin') !== appOrigin) {
    return deny('ORIGIN_NOT_ALLOWED', 403);
  }
  if (login) return null;
  if (!session) return deny('SESSION_REQUIRED', 401);
  const token = request.headers.get('X-CSRF-Token');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return deny('CSRF_INVALID', 403);
  const hash = await secretHash(token);
  if (typeof session.csrfHash !== 'string' || session.csrfHash.length !== 64
    || !timingSafeEqual(encoder.encode(hash), encoder.encode(session.csrfHash))) {
    return deny('CSRF_INVALID', 403);
  }
  return null;
}
