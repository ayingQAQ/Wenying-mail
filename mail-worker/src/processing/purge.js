import {acquireStorageLock,assertStorageLock,releaseStorageLock} from './storage-lock.js';
import {purgeLegacyMail} from './legacy-purge.js';

const now='unixepoch()*1000';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export async function purgeMail(env) {
  const lock=await acquireStorageLock(env.db,'PURGE');
  if(!lock) return {busy:true};
  let job;
  try {
    job=await env.db.prepare(`SELECT d.*,t.deleted_at,t.reason_code FROM mail_deletion_jobs d
      JOIN mail_tombstones t ON t.delivery_id=d.delivery_id WHERE d.state IN ('TOMBSTONE_PERSISTED','PURGING')
      AND d.wait_until<=${now} AND d.next_attempt_at<=${now} ORDER BY d.next_attempt_at,d.requested_at LIMIT 1`).first();
    if(!job) return {idle:true};
    if(!['legacy','legacy-r2-v1','r2-v1'].includes(job.storage_version)) throw new Error('LEGACY_PURGE_PENDING');
    if(job.storage_version==='r2-v1' && (!uuid.test(job.delivery_id) || typeof job.raw_key!=='string' ||
      !new RegExp(`^raw/\\d{4}/\\d{2}/\\d{2}/${job.delivery_id}\\.eml$`).test(job.raw_key))) throw new Error('INVALID_PURGE_IDENTITY');
    const marker=await env.r2.get(`tombstones/${job.delivery_id}.json`);
    if(!marker || marker.size>512 || await marker.text()!==JSON.stringify({version:1,deliveryId:job.delivery_id,deletedAt:job.deleted_at,reasonCode:job.reason_code})) throw new Error('TOMBSTONE_UNVERIFIED');
    await assertStorageLock(env.db,lock);
    await env.db.prepare(`UPDATE mail_deletion_jobs SET state='PURGING',updated_at=${now} WHERE delivery_id=?`).bind(job.delivery_id).run();
    if(['legacy','legacy-r2-v1'].includes(job.storage_version)) return await purgeLegacyMail(env,job,lock);
    const prefixes=['derived','attachments','inline'].map(kind=>`${kind}/${job.delivery_id}/`);
    // Delete at most one page per invocation. Restarting from the prefix start
    // avoids continuation-token ambiguity while objects are being removed.
    for(const prefix of prefixes) {
      const page=await env.r2.list({prefix,limit:100});
      if(page.objects.length) {
        const keys=page.objects.map(object=>object.key);
        if(keys.some(key=>!key.startsWith(prefix))) throw new Error('INVALID_PURGE_PAGE');
        await assertStorageLock(env.db,lock);
        await env.r2.delete(keys);
        return {deliveryId:job.delivery_id,deleted:keys.length,complete:false};
      }
    }
    await assertStorageLock(env.db,lock);
    await env.r2.delete(job.raw_key);
    for(const prefix of prefixes) if((await env.r2.list({prefix,limit:1})).objects.length) throw new Error('PURGE_NOT_EMPTY');
    if(await env.r2.head(job.raw_key)) throw new Error('PURGE_NOT_EMPTY');
    await assertStorageLock(env.db,lock);
    // Authoritative storage lock and deletion identity must still hold for the
    // entire D1 transaction. Keep the minimal intent/tombstone, erase mail data.
    const gate=`EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})
      AND EXISTS(SELECT 1 FROM mail_deletion_jobs d JOIN mail_tombstones t ON t.delivery_id=d.delivery_id
        WHERE d.delivery_id=? AND d.state='PURGING' AND d.email_id IS ? AND d.raw_key=?)`;
    const args=[lock.owner,job.delivery_id,job.email_id,job.raw_key];
    await env.db.batch([
      env.db.prepare(`DELETE FROM attachments WHERE email_id=? AND ${gate}`).bind(job.email_id,...args),
      env.db.prepare(`DELETE FROM star WHERE email_id=? AND ${gate}`).bind(job.email_id,...args),
      env.db.prepare(`DELETE FROM email WHERE email_id=? AND delivery_id=? AND delete_state='DELETE_REQUESTED' AND ${gate}`).bind(job.email_id,job.delivery_id,...args),
      env.db.prepare(`DELETE FROM mail_processing WHERE delivery_id=? AND ${gate}`).bind(job.delivery_id,...args),
      env.db.prepare(`INSERT INTO audit_logs(action,target_id,result_code,created_at)
        SELECT 'mail.purged',CAST(? AS TEXT),'SUCCESS',${now} WHERE ${gate}`).bind(job.email_id,...args),
      env.db.prepare(`UPDATE mail_deletion_jobs SET state='PURGED',raw_key=NULL,last_error_code=NULL,updated_at=${now}
        WHERE delivery_id=? AND ${gate}`).bind(job.delivery_id,...args),
      env.db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})
        AND EXISTS(SELECT 1 FROM mail_deletion_jobs WHERE delivery_id=? AND state='PURGED')
        AND NOT EXISTS(SELECT 1 FROM email WHERE email_id=?) AND NOT EXISTS(SELECT 1 FROM attachments WHERE email_id=?)
        AND NOT EXISTS(SELECT 1 FROM star WHERE email_id=?) AND NOT EXISTS(SELECT 1 FROM mail_processing WHERE delivery_id=?)
        THEN 1 ELSE json('PURGE_GUARD_LOST') END`).bind(lock.owner,job.delivery_id,job.email_id,job.email_id,job.email_id,job.delivery_id),
    ]);
    return {deliveryId:job.delivery_id,complete:true};
  } catch(error) {
    if(job) await env.db.prepare(`UPDATE mail_deletion_jobs SET attempts=attempts+1,last_error_code=?,next_attempt_at=${now}+60000,updated_at=${now}
      WHERE delivery_id=? AND state<>'PURGED'`).bind(error.message==='LEGACY_PURGE_PENDING' ? 'LEGACY_PURGE_PENDING':'PURGE_RETRY',job.delivery_id).run();
    return {retry:true};
  } finally {await releaseStorageLock(env.db,lock);}
}
