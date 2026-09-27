import { decodeProcessingEvent } from './queue-event.js';
import { registerRaw, claimJob, failJob } from './jobs.js';
import { prepareGeneration } from './generation.js';
import { publishGeneration } from './publication.js';
import { PROCESSOR_VERSION } from './mime.js';
import { notifyTelegram } from '../service/telegram-notification.js';

async function state(db,deliveryId) {
  return db.prepare(`SELECT p.state,p.next_attempt_at,p.lease_until,unixepoch()*1000 AS db_now,
    EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=x.id) OR
    EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=x.id) AS deleted
    FROM (SELECT ? AS id) x LEFT JOIN mail_processing p ON p.delivery_id=x.id`).bind(deliveryId).first();
}
function disposition(row) {
  if (row?.deleted || ['PROCESSED','QUARANTINED'].includes(row?.state)) return {ack:true};
  const due=row?.state==='PROCESSING' ? row.lease_until:row?.next_attempt_at;
  return {delaySeconds:Math.min(86400,Math.max(1,Math.ceil(((due || row?.db_now || 0)-(row?.db_now || 0))/1000) || 60))};
}
function errorCode(error) {
  const code=error?.message;
  if (['INVALID_MIME','MIME_LIMIT_EXCEEDED','PARSE_UNKNOWN'].includes(code)) return code;
  if (['RAW_NOT_FOUND','RAW_IDENTITY_CONFLICT','RAW_LENGTH_MISMATCH','INVALID_RAW_METADATA'].includes(code)) return 'RAW_INVALID';
  if (['DERIVED_OBJECT_CONFLICT','INVALID_GENERATION','PROCESSOR_VERSION_MISMATCH'].includes(code)) return 'GENERATION_INVALID';
  return 'STORAGE_UNAVAILABLE';
}
async function processMessage(body,env) {
  const reference=decodeProcessingEvent(body,{account:env.MAIL_CLOUDFLARE_ACCOUNT,bucket:env.MAIL_R2_BUCKET});
  let row=await state(env.db,reference.deliveryId);
  if (row.deleted || ['PROCESSED','QUARANTINED','FAILED'].includes(row.state)) return disposition(row);
  // Restore can leave an R2 tombstone before D1 has its matching row.
  if (await env.r2.head(`tombstones/${reference.deliveryId}.json`)) return {ack:true};
  if (!row.state) {
    if (!await registerRaw(env.db,env.r2,reference)) return {ack:true};
    row=await state(env.db,reference.deliveryId);
    if (row.deleted || ['QUARANTINED','PROCESSED'].includes(row.state)) return disposition(row);
  }
  const lease=await claimJob(env.db,reference.deliveryId,PROCESSOR_VERSION);
  if (!lease) return disposition(await state(env.db,reference.deliveryId));
  try {
    const manifest=await prepareGeneration(env.db,env.r2,lease);
    await publishGeneration(env.db,env.r2,lease,manifest);
    // Notifications are advisory and cannot undo committed publication.
    try{env.MAIL_EVENTS?.publish(lease.user_id);}catch{}
    await notifyTelegram(env,lease.delivery_id);
    return {ack:true};
  } catch(error) {
    if (error?.message!=='LEASE_LOST') await failJob(env.db,lease,errorCode(error));
    return disposition(await state(env.db,reference.deliveryId));
  }
}

export async function consumeMailQueue(batch,env) {
  if(env.MAIL_DLQ_NAME&&batch.queue===env.MAIL_DLQ_NAME) {
    for(const message of batch.messages) {
      let id=null,code='INVALID_EVENT';
      try {id=decodeProcessingEvent(message.body,{account:env.MAIL_CLOUDFLARE_ACCOUNT,bucket:env.MAIL_R2_BUCKET}).deliveryId;code='DELIVERY_EXHAUSTED';}catch{}
      try {
        await env.db.prepare("INSERT INTO operations_events(delivery_id,stage,code) VALUES(?,'DLQ',?)").bind(id,code).run();
        message.ack();
      }catch {message.retry({delaySeconds:60});}
    }
    return;
  }
  if (!env.MAIL_QUEUE_NAME || batch.queue!==env.MAIL_QUEUE_NAME ||
      !env.MAIL_CLOUDFLARE_ACCOUNT || !env.MAIL_R2_BUCKET) throw new Error('QUEUE_SOURCE_UNCONFIGURED');
  // Production configuration must initially use batch size/concurrency 1.
  for (const message of batch.messages) {
    let result;
    try { result=await processMessage(message.body,env); }
    catch { result={delaySeconds:60}; }
    // Exactly one disposition. No ack before durable publication/quarantine/delete.
    if (result.ack) message.ack();
    else message.retry({delaySeconds:result.delaySeconds});
  }
}
