// ASCII envelope addresses only for the initial personal-domain deployment.
// Keep +tags intact and never use headers or legacy catch-all flags for routing.
export async function admitMailbox(db, recipient) {
  if (typeof recipient !== 'string' || recipient.length > 254 ||
      !/^[\x21-\x7e]+$/.test(recipient)) return null;
  const parts = recipient.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !parts[1]) return null;
  try {
    return await db.prepare(`SELECT a.account_id AS accountId, a.user_id AS userId
      FROM account a JOIN user u ON u.user_id=a.user_id
      JOIN domains d ON d.domain_id=a.domain_id
      WHERE a.email=? COLLATE NOCASE AND d.name=? COLLATE NOCASE
        AND a.is_del=0 AND a.retired_at IS NULL AND a.receive_enabled=1
        AND u.is_del=0 AND u.retired_at IS NULL AND u.status=0 AND d.enabled=1 LIMIT 1`)
      .bind(recipient.toLowerCase(), parts[1].toLowerCase()).first();
  } catch {
    throw new Error('ADMISSION_UNAVAILABLE');
  }
}
