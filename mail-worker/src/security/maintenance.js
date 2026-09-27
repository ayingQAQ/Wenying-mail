const DAY = 86400000;

export async function maintainSecurity(db, { now = Date.now(), limit = 250 } = {}) {
  if (!Number.isSafeInteger(now) || now < 90 * DAY || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('INVALID_MAINTENANCE_OPTIONS');
  }
  const results = await db.batch([
    db.prepare(`DELETE FROM audit_logs WHERE id IN (
      SELECT id FROM audit_logs WHERE created_at<? ORDER BY created_at,id LIMIT ?)`)
      .bind(now - 90 * DAY, limit),
    db.prepare(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM (
        SELECT token_hash FROM (SELECT token_hash FROM sessions WHERE expires_at<? ORDER BY expires_at LIMIT ?)
        UNION SELECT token_hash FROM (SELECT token_hash FROM sessions WHERE revoked_at<? ORDER BY revoked_at LIMIT ?)
      ) LIMIT ?)`)
      .bind(now - DAY, limit, now - DAY, limit, limit),
    db.prepare(`DELETE FROM auth_attempts WHERE rate_key IN (
      SELECT rate_key FROM auth_attempts WHERE window_start<? ORDER BY window_start LIMIT ?)`)
      .bind(now - DAY, limit),
  ]);
  return { audit: results[0].meta.changes, sessions: results[1].meta.changes, attempts: results[2].meta.changes };
}
