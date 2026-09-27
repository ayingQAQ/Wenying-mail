import BizError from '../error/biz-error.js';
import {mailIds} from './mail-folders.js';

const now='unixepoch()*1000';
const identity="coalesce(e.delivery_id,'legacy-email-'||e.email_id)";
export async function requestMailDeletion(db,input,actorUserId,{admin=false,system=false,expired=false}={}) {
  const requestedIds=mailIds(input);
  if(!(system && admin && actorUserId===null) && (!Number.isSafeInteger(actorUserId) || actorUserId<1)) throw new BizError('UNAUTHORIZED',403);
  const completed=(await db.prepare(`SELECT email_id FROM mail_deletion_jobs WHERE state='PURGED'
    AND email_id IN (SELECT value FROM json_each(?)) AND (?=1 OR user_id=?)`)
    .bind(JSON.stringify(requestedIds),admin ? 1:0,actorUserId).all()).results;
  const done=new Set(completed.map(row=>row.email_id));
  const ids=requestedIds.filter(id=>!done.has(id)),json=JSON.stringify(ids);
  if(!ids.length) return {emailIds:requestedIds,state:'PURGED'};
  if(expired && !(system && admin)) throw new BizError('UNAUTHORIZED',403);
  const gate=expired ? `e.folder='TRASH' AND e.trashed_at IS NOT NULL AND e.trashed_at<=${now}-2592000000`:admin ? '1':`e.user_id=${actorUserId} AND e.folder='TRASH' AND EXISTS
    (SELECT 1 FROM account a WHERE a.account_id=e.account_id AND a.user_id=e.user_id AND a.is_del=0)`;
  const count=await db.prepare(`SELECT count(*) n FROM email e WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate}`)
    .bind(json).first();
  if(count.n!==ids.length) throw new BizError('NOT_FOUND',404);
  await db.batch([
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT ?,'mail.permanent.requested',CAST(e.email_id AS TEXT),'SUCCESS',${now} FROM email e
      WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate}
      AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=e.email_id)`).bind(actorUserId,json),
    db.prepare(`INSERT INTO mail_deletion_jobs(delivery_id,email_id,state,requested_at,updated_at,user_id,account_id,raw_key,storage_version,wait_until)
      SELECT ${identity},e.email_id,'DELETE_REQUESTED',${now},${now},e.user_id,e.account_id,e.raw_r2_key,e.storage_version,
      max(${now},coalesce((SELECT p.lease_until FROM mail_processing p WHERE p.delivery_id=e.delivery_id),0),
        coalesce((SELECT b.lease_until FROM legacy_backfill_jobs b WHERE b.email_id=e.email_id),0))+60000
      FROM email e WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate}
      ON CONFLICT(delivery_id) DO NOTHING`).bind(json),
    db.prepare(`INSERT INTO mail_tombstones(delivery_id,deleted_at,reason_code)
      SELECT d.delivery_id,d.requested_at,'${expired ? 'TRASH_EXPIRED':'USER_DELETE'}' FROM mail_deletion_jobs d JOIN email e ON e.email_id=d.email_id
      WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate} ON CONFLICT(delivery_id) DO NOTHING`).bind(json),
    db.prepare(`UPDATE mail_processing SET lease_epoch=lease_epoch+1,lease_owner=NULL
      WHERE delivery_id IN (SELECT ${identity} FROM email e WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate})
      AND lease_owner IS NOT NULL`).bind(json),
    db.prepare(`UPDATE email AS e SET delete_state='DELETE_REQUESTED' WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate}`).bind(json),
    db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM email e JOIN mail_deletion_jobs d ON d.email_id=e.email_id
      JOIN mail_tombstones t ON t.delivery_id=d.delivery_id WHERE e.email_id IN (SELECT value FROM json_each(?)) AND ${gate}
      AND e.delete_state='DELETE_REQUESTED' AND d.user_id=e.user_id AND d.account_id=e.account_id AND d.delivery_id=${identity})=?
      THEN 1 ELSE json('DELETION_GUARD_LOST') END`).bind(json,ids.length),
  ]);
  return {emailIds:requestedIds,state:'DELETE_REQUESTED'};
}

export async function expireTrash(db) {
  const rows=(await db.prepare(`SELECT email_id FROM email e WHERE folder='TRASH' AND delete_state='ACTIVE' AND is_del=0
    AND trashed_at<=${now}-2592000000 AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=e.email_id)
    ORDER BY trashed_at,email_id LIMIT 20`).all()).results;
  if(!rows.length) return {requested:0};
  await requestMailDeletion(db,rows.map(row=>row.email_id),null,{admin:true,system:true,expired:true});
  return {requested:rows.length};
}

export async function deletionStatus(db,userId) {
  return (await db.prepare(`SELECT email_id AS emailId,state,requested_at AS requestedAt,updated_at AS updatedAt,
    CASE WHEN last_error_code IS NULL THEN 0 ELSE 1 END AS retrying FROM mail_deletion_jobs
    WHERE user_id=? AND email_id IS NOT NULL ORDER BY requested_at DESC,email_id DESC LIMIT 30`).bind(userId).all()).results;
}

export async function persistDeletionTombstones(env) {
  const jobs=(await env.db.prepare(`SELECT d.*,t.deleted_at,t.reason_code FROM mail_deletion_jobs d
    JOIN mail_tombstones t ON t.delivery_id=d.delivery_id WHERE d.state='DELETE_REQUESTED' AND d.next_attempt_at<=${now}
    ORDER BY d.next_attempt_at,d.requested_at LIMIT 10`).all()).results;
  let persisted=0;
  for(const job of jobs) {
    try {
      if(!/^(?:[a-f0-9-]{36}|legacy-email-[1-9]\d*)$/.test(job.delivery_id)) throw new Error('INVALID_ID');
      const key=`tombstones/${job.delivery_id}.json`;
      const body=JSON.stringify({version:1,deliveryId:job.delivery_id,deletedAt:job.deleted_at,reasonCode:job.reason_code});
      const object=await env.r2.put(key,body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
      if(!object) {
        const existing=await env.r2.get(key);
        if(!existing || existing.size>512 || await existing.text()!==body) throw new Error('TOMBSTONE_CONFLICT');
      }
      await env.db.prepare(`UPDATE mail_deletion_jobs SET state='TOMBSTONE_PERSISTED',last_error_code=NULL,
        next_attempt_at=max(wait_until,${now}),updated_at=${now} WHERE delivery_id=? AND state='DELETE_REQUESTED'`)
        .bind(job.delivery_id).run();
      persisted++;
    } catch {
      await env.db.prepare(`UPDATE mail_deletion_jobs SET attempts=attempts+1,last_error_code='TOMBSTONE_WRITE_FAILED',
        next_attempt_at=${now}+60000,updated_at=${now} WHERE delivery_id=? AND state='DELETE_REQUESTED'`).bind(job.delivery_id).run();
    }
  }
  return {attempted:jobs.length,persisted};
}
