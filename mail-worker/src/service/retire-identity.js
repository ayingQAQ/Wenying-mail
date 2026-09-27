import {mailIds} from './mail-folders.js';
import {requestMailDeletion} from './mail-deletion.js';
import BizError from '../error/biz-error.js';
const now="CAST(unixepoch('subsec')*1000 AS INTEGER)";

export async function retireAccounts(db,input,actorUserId,ownerOnly=false) {
  const ids=mailIds(input),json=JSON.stringify(ids);
  const gate=ownerOnly ? 'AND user_id=?':'';
  const bindings=ownerOnly ? [json,actorUserId]:[json];
  if((await db.prepare(`SELECT count(*) n FROM account WHERE account_id IN (SELECT value FROM json_each(?)) ${gate}`).bind(...bindings).first()).n!==ids.length) throw new BizError('NOT_FOUND',404);
  await db.batch([
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT ?,'account.retired',CAST(account_id AS TEXT),'SUCCESS',${now} FROM account
      WHERE account_id IN (SELECT value FROM json_each(?)) AND is_del=0 ${gate}`).bind(actorUserId,...bindings),
    db.prepare(`UPDATE account SET is_del=1,retired_through=max(retired_through,${now}),retired_at=coalesce(retired_at,${now}),receive_enabled=0,disabled_at=coalesce(disabled_at,${now})
      WHERE account_id IN (SELECT value FROM json_each(?)) ${gate}`).bind(...bindings),
    db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM account WHERE account_id IN (SELECT value FROM json_each(?))
      AND is_del=1 AND receive_enabled=0 ${gate})=? THEN 1 ELSE json('RETIRE_GUARD_LOST') END`).bind(...bindings,ids.length),
  ]);
}
export async function retireUsers(db,input,actorUserId) {
  const ids=mailIds(input),json=JSON.stringify(ids);
  if((await db.prepare('SELECT count(*) n FROM user WHERE user_id IN (SELECT value FROM json_each(?))').bind(json).first()).n!==ids.length) throw new BizError('NOT_FOUND',404);
  await db.batch([
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT ?,'user.retired',CAST(user_id AS TEXT),'SUCCESS',${now} FROM user WHERE user_id IN (SELECT value FROM json_each(?)) AND is_del=0`).bind(actorUserId,json),
    db.prepare(`UPDATE user SET is_del=1,status=1,retired_through=max(retired_through,${now}),retired_at=coalesce(retired_at,${now}) WHERE user_id IN (SELECT value FROM json_each(?))`).bind(json),
    db.prepare(`UPDATE account SET is_del=1,retired_through=max(retired_through,${now}),retired_at=coalesce(retired_at,${now}),receive_enabled=0,disabled_at=coalesce(disabled_at,${now}) WHERE user_id IN (SELECT value FROM json_each(?))`).bind(json),
    db.prepare(`UPDATE sessions SET revoked_at=${now} WHERE user_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL`).bind(json),
    db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM user WHERE user_id IN (SELECT value FROM json_each(?))
      AND retired_at IS NOT NULL AND is_del=1 AND status=1)=? AND NOT EXISTS(SELECT 1 FROM account
      WHERE user_id IN (SELECT value FROM json_each(?)) AND (is_del<>1 OR receive_enabled<>0 OR retired_at IS NULL))
      THEN 1 ELSE json('RETIRE_GUARD_LOST') END`).bind(json,ids.length,json),
  ]);
}
export async function sweepRetiredMail(db) {
  const rows=(await db.prepare(`SELECT e.email_id FROM email e JOIN account a ON a.account_id=e.account_id JOIN user u ON u.user_id=e.user_id
    WHERE (a.retired_at IS NOT NULL OR u.retired_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=e.email_id)
    ORDER BY e.email_id LIMIT 20`).all()).results;
  if(rows.length) await requestMailDeletion(db,rows.map(row=>row.email_id),null,{admin:true,system:true});
  // Repeat every run: an accepted raw may be registered after identity retirement.
  // Capture pre-publication jobs too, without inventing an email projection.
  await db.batch([
    db.prepare(`INSERT INTO mail_deletion_jobs(delivery_id,email_id,state,requested_at,updated_at,user_id,account_id,raw_key,storage_version,wait_until)
      SELECT p.delivery_id,NULL,'DELETE_REQUESTED',${now},${now},p.user_id,p.account_id,p.raw_key,'r2-v1',max(${now},p.lease_until)+60000
      FROM mail_processing p JOIN account a ON a.account_id=p.account_id JOIN user u ON u.user_id=p.user_id
      WHERE (a.retired_at IS NOT NULL OR u.retired_at IS NOT NULL) AND p.email_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=p.delivery_id) LIMIT 20`),
    db.prepare(`INSERT INTO mail_tombstones(delivery_id,deleted_at,reason_code)
      SELECT d.delivery_id,d.requested_at,'IDENTITY_RETIRED' FROM mail_deletion_jobs d WHERE d.email_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=d.delivery_id) LIMIT 20`),
    db.prepare(`UPDATE mail_processing SET lease_epoch=lease_epoch+1,lease_owner=NULL WHERE delivery_id IN
      (SELECT p.delivery_id FROM mail_processing p JOIN mail_deletion_jobs d ON d.delivery_id=p.delivery_id
        WHERE d.email_id IS NULL AND p.lease_owner IS NOT NULL LIMIT 20)`),
  ]);
  return {emails:rows.length};
}
