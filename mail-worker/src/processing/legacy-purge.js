import {DeleteObjectCommand,HeadObjectCommand,GetBucketVersioningCommand} from '@aws-sdk/client-s3';
import {legacyS3Client} from '../runtime/legacy-s3-client.js';
import {assertStorageLock} from './storage-lock.js';
import {purgeS3Versions} from './s3-version-purge.js';
import {checkBackfillObject,backfillKey} from './legacy-backfill-format.js';

const now='unixepoch()*1000';
const unavailable=()=>new Error('LEGACY_PURGE_PENDING');

async function removeObject(env,backend,key,lock) {
  if(backend==='r2') {
    await assertStorageLock(env.db,lock);
    await env.r2.delete(key);
    if(await env.r2.head(key)) throw unavailable();
    return;
  }
  if(backend==='kv') {
    await assertStorageLock(env.db,lock);
    await env.kv.delete(key);
    // KV can serve a stale value; retain the reference and retry later.
    if(await env.kv.get(key,{type:'arrayBuffer'})!==null) throw unavailable();
    return;
  }
  if(backend!=='s3') throw unavailable();
  const client=legacyS3Client(env);
  const target={Bucket:env.LEGACY_S3_BUCKET,Key:key};
  try {
    const versioning=await client.send(new GetBucketVersioningCommand({Bucket:target.Bucket}));
    if(['Enabled','Suspended'].includes(versioning.Status))return await purgeS3Versions(client,target,()=>assertStorageLock(env.db,lock));
    if(versioning.Status!==undefined)throw unavailable();
    await assertStorageLock(env.db,lock);
    await client.send(new DeleteObjectCommand(target));
    try {await client.send(new HeadObjectCommand(target));}
    catch(error) {
      if(error.name==='NotFound' && error.$metadata?.httpStatusCode===404){
        // Versioning enabled during the operation may have left history behind.
        if((await client.send(new GetBucketVersioningCommand({Bucket:target.Bucket}))).Status!==undefined)throw unavailable();
        return;
      }
      throw error;
    }
    throw unavailable();
  } finally {client.destroy();}
}

export async function purgeLegacyMail(env,job,lock) {
  if(!Number.isSafeInteger(job.email_id) || job.delivery_id!==`legacy-email-${job.email_id}` || job.raw_key!==null)
    throw unavailable();
  const email=await env.db.prepare("SELECT 1 FROM email WHERE email_id=? AND storage_version IN ('legacy','legacy-r2-v1') AND delivery_id IS NULL AND delete_state='DELETE_REQUESTED'")
    .bind(job.email_id).first();
  if(!email) throw unavailable();
  const copies=(await env.db.prepare(`SELECT o.*,j.source_hash FROM legacy_backfill_objects o
    LEFT JOIN legacy_backfill_jobs j ON j.email_id=o.email_id WHERE o.email_id=? ORDER BY o.part LIMIT 20`).bind(job.email_id).all()).results;
  for(const copy of copies){
    if(copy.key!==backfillKey(job.email_id,copy.source_hash,copy.part))throw unavailable();
    await assertStorageLock(env.db,lock);
    const existing=await env.r2.head(copy.key);
    if(existing){checkBackfillObject(existing,copy,copy.source_hash);await env.r2.delete(copy.key);}
    if(await env.r2.head(copy.key))throw unavailable();
    await env.db.batch([
      env.db.prepare(`DELETE FROM legacy_backfill_objects WHERE email_id=? AND part=? AND key=?
        AND EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})`)
        .bind(job.email_id,copy.part,copy.key,lock.owner),
      env.db.prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM legacy_backfill_objects WHERE email_id=? AND part=?) THEN 1 ELSE json('LEGACY_PURGE_GUARD_LOST') END")
        .bind(job.email_id,copy.part),
    ]);
  }
  if(copies.length)return {deliveryId:job.delivery_id,processed:copies.length,complete:false};
  const {results:rows}=await env.db.prepare('SELECT * FROM attachments WHERE email_id=? ORDER BY att_id LIMIT 20').bind(job.email_id).all();
  let processed=0;
  for(const row of rows) {
    const backend=row.storage_backend==='legacy' ? env.LEGACY_MAIL_STORAGE:row.storage_backend;
    if(row.storage_version!=='legacy' || !['r2','kv','s3'].includes(backend) || typeof row.key!=='string' ||
      !/^attachments\/[A-Za-z0-9_.-]+$/.test(row.key) || row.key.length>512) throw unavailable();
    // Include other users, deleted messages, drafts and malformed/orphan rows.
    // A reference is live until its own cleanup removes it, irrespective of UI visibility.
    const shared=await env.db.prepare(`SELECT 1 FROM attachments WHERE key=? AND att_id<>?
      AND (storage_backend=? OR storage_backend IS NULL OR storage_backend NOT IN ('legacy','r2','kv','s3')
        OR (storage_backend='legacy' AND (? IS NULL OR ?=?))) LIMIT 1`)
      .bind(row.key,row.att_id,backend,env.LEGACY_MAIL_STORAGE ?? null,env.LEGACY_MAIL_STORAGE ?? null,backend).first();
    const removed=!shared?await removeObject(env,backend,row.key,lock):undefined;
    if(removed?.pending)return {deliveryId:job.delivery_id,processed,versionsDeleted:removed.versionsDeleted,complete:false};
    await assertStorageLock(env.db,lock);
    await env.db.batch([
      env.db.prepare(`DELETE FROM attachments WHERE att_id=? AND email_id=? AND key=?
        AND EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})`)
        .bind(row.att_id,job.email_id,row.key,lock.owner),
      env.db.prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attachments WHERE att_id=?) THEN 1 ELSE json('LEGACY_PURGE_GUARD_LOST') END").bind(row.att_id),
    ]);
    processed++;
    // One external S3 attachment per invocation bounds versioned work even if
    // many attachments happen to have only a handful of historical versions.
    if(backend==='s3'&&!shared)return {deliveryId:job.delivery_id,processed,versionsDeleted:removed?.versionsDeleted??0,complete:false};
  }
  if(rows.length) return {deliveryId:job.delivery_id,processed,complete:false};
  await assertStorageLock(env.db,lock);
  const gate=`EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})
    AND EXISTS(SELECT 1 FROM mail_deletion_jobs d JOIN mail_tombstones t ON t.delivery_id=d.delivery_id
      WHERE d.delivery_id=? AND d.email_id=? AND d.storage_version IN ('legacy','legacy-r2-v1') AND d.state='PURGING')
    AND NOT EXISTS(SELECT 1 FROM attachments WHERE email_id=?)`;
  const args=[lock.owner,job.delivery_id,job.email_id,job.email_id];
  await env.db.batch([
    env.db.prepare(`DELETE FROM legacy_backfill_jobs WHERE email_id=? AND ${gate}`).bind(job.email_id,...args),
    env.db.prepare(`DELETE FROM star WHERE email_id=? AND ${gate}`).bind(job.email_id,...args),
    env.db.prepare(`DELETE FROM email WHERE email_id=? AND storage_version IN ('legacy','legacy-r2-v1') AND delete_state='DELETE_REQUESTED' AND ${gate}`).bind(job.email_id,...args),
    env.db.prepare(`INSERT INTO audit_logs(action,target_id,result_code,created_at) SELECT 'mail.purged',CAST(? AS TEXT),'SUCCESS',${now} WHERE ${gate}`).bind(job.email_id,...args),
    env.db.prepare(`UPDATE mail_deletion_jobs SET state='PURGED',last_error_code=NULL,updated_at=${now} WHERE delivery_id=? AND ${gate}`).bind(job.delivery_id,...args),
    env.db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM mail_deletion_jobs WHERE delivery_id=? AND state='PURGED')
      AND NOT EXISTS(SELECT 1 FROM email WHERE email_id=?) AND NOT EXISTS(SELECT 1 FROM star WHERE email_id=?)
      THEN 1 ELSE json('LEGACY_PURGE_GUARD_LOST') END`).bind(job.delivery_id,job.email_id,job.email_id),
  ]);
  return {deliveryId:job.delivery_id,complete:true};
}
