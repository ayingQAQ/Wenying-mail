import { secretHash } from './session.js';

const WINDOW_MS = 15 * 60 * 1000;

export async function reserveLoginAttempt(db, accessSub, email) {
  const now = Date.now();
  const keys = await Promise.all([
    secretHash(`access:${accessSub}`),
    secretHash(`login:${JSON.stringify([accessSub, email.toLowerCase()])}`),
  ]);
  // Reserve before expensive password work, so simultaneous failures cannot bypass the limit.
  const results = await db.batch(keys.map(key => db.prepare(`
    INSERT INTO auth_attempts(rate_key,window_start,attempt_count) VALUES (?,?,1)
    ON CONFLICT(rate_key) DO UPDATE SET
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END,
      attempt_count=CASE WHEN window_start<=? THEN 1 ELSE attempt_count+1 END
    WHERE window_start<=? OR attempt_count<5
    RETURNING rate_key,window_start`).bind(key, now, now-WINDOW_MS, now-WINDOW_MS, now-WINDOW_MS)));
  const reserved = results.flatMap(result => result.results);
  if (reserved.length !== keys.length) {
    // Return any partial reservations: a denied attempt did not perform expensive verification.
    await releaseSuccessfulAttempt(db, reserved);
    return null;
  }
  return reserved;
}

export async function releaseSuccessfulAttempt(db, reservation) {
  if (!reservation?.length) return;
  await db.batch(reservation.map(row => db.prepare(`UPDATE auth_attempts
    SET attempt_count=MAX(0,attempt_count-1) WHERE rate_key=? AND window_start=?`)
    .bind(row.rate_key, row.window_start)));
}
