const events = {
  'auth.login': ['SUCCESS', 'INVALID_CREDENTIALS'],
  'auth.session.revoked': ['LOGOUT', 'ROTATED', 'USER_RESET'],
  'auth.password.changed': ['SUCCESS'],
};
const fields = new Set(['action', 'code', 'actorUserId', 'targetId']);

function validate(event) {
  if (!event || Object.keys(event).some(key => !fields.has(key)) || !events[event.action]?.includes(event.code)
    || [event.actorUserId, event.targetId].some(id => id != null && (!Number.isSafeInteger(id) || id < 1))) {
    throw new Error('INVALID_AUDIT_EVENT');
  }
}

export function auditStatement(db, event) {
  validate(event);
  return db.prepare('INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) VALUES (?,?,?,?,?)')
    .bind(event.actorUserId ?? null, event.action, event.targetId == null ? null : String(event.targetId), event.code, Date.now());
}

export function sessionAuditStatement(db, tokenHash, action, code) {
  validate({ action, code });
  // The credential hash is a lookup parameter only, never part of the audit row.
  return db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
    SELECT user_id,?,CAST(user_id AS TEXT),?,? FROM sessions
    WHERE token_hash=? AND revoked_at IS NULL`).bind(action, code, Date.now(), tokenHash);
}

export function userAuditStatement(db, event) {
  validate(event);
  if (!event.targetId) throw new Error('INVALID_AUDIT_EVENT');
  return db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
    SELECT ?,?,CAST(user_id AS TEXT),?,? FROM user WHERE user_id=? AND is_del=0`)
    .bind(event.actorUserId ?? null, event.action, event.code, Date.now(), event.targetId);
}
