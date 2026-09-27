import BizError from '../error/biz-error.js';

export function mailIds(input) {
  const values=Array.isArray(input) ? input:typeof input==='string' ? input.split(','):[];
  if(!values.length || values.length>50 || values.some(value=>!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<1)) throw new BizError('INVALID_EMAIL_IDS',400);
  return [...new Set(values.map(Number))];
}
const visible=`e.user_id=? AND e.is_del=0 AND e.delete_state='ACTIVE'
  AND EXISTS(SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id WHERE a.account_id=e.account_id
    AND a.user_id=e.user_id AND a.is_del=0 AND a.retired_at IS NULL AND u.is_del=0 AND u.retired_at IS NULL AND u.status=0)
  AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=e.delivery_id)
  AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=e.delivery_id)`;

export async function changeMailFolder(db,input,userId,folder) {
  const ids=mailIds(input),encoded=JSON.stringify(ids);
  if(!['INBOX','TRASH'].includes(folder)) throw new BizError('INVALID_FOLDER',400);
  const count=await db.prepare(`SELECT COUNT(*) n FROM email e WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${visible}`)
    .bind(encoded,userId).first();
  if(count.n!==ids.length) throw new BizError('NOT_FOUND',404);
  // Audit only transitions, in the same transaction as state. Duplicate requests
  // preserve the original trash timestamp and do not extend retention.
  await db.batch([
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT ?,?,CAST(e.email_id AS TEXT),'SUCCESS',unixepoch()*1000 FROM email e
      WHERE e.email_id IN (SELECT value FROM json_each(?)) AND e.folder<>? AND ${visible}`)
      .bind(userId,folder==='TRASH' ? 'mail.trash':'mail.restore',encoded,folder,userId),
    db.prepare(`UPDATE email AS e SET folder=?,trashed_at=CASE WHEN ?='TRASH' THEN unixepoch()*1000 ELSE NULL END
      WHERE e.email_id IN (SELECT value FROM json_each(?)) AND e.folder<>? AND ${visible}`)
      .bind(folder,folder,encoded,folder,userId),
    db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM email e WHERE e.email_id IN (SELECT value FROM json_each(?))
      AND e.folder=? AND ${visible})=? THEN 1 ELSE json('FOLDER_GUARD_LOST') END`)
      .bind(encoded,folder,userId,ids.length),
  ]);
  return {emailIds:ids,folder};
}

export async function listTrash(db,userId,{before,limit=30}={}) {
  limit=Number(limit);
  if(!Number.isInteger(limit) || limit<1 || limit>50) throw new BizError('INVALID_LIMIT',400);
  const cursor=before==null ? Number.MAX_SAFE_INTEGER:mailIds([before])[0];
  return (await db.prepare(`SELECT e.email_id AS emailId,e.subject,e.name,e.send_email AS sendEmail,e.trashed_at AS trashedAt,
    e.create_time AS createTime,e.unread,e.folder FROM email e WHERE ${visible} AND e.folder='TRASH' AND e.email_id<?
    ORDER BY e.email_id DESC LIMIT ?`).bind(userId,cursor,limit).all()).results;
}
