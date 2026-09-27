import BizError from '../error/biz-error.js';
import {requestMailDeletion} from './mail-deletion.js';
import {loadRawDescriptor} from '../processing/queue-event.js';
const now='unixepoch()*1000';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const positive=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new BizError('INVALID_ID',400);return n;};
export const isAdmin=c=>typeof c.env.admin==='string'&&c.get('user').email.toLowerCase()===c.env.admin.toLowerCase();
export function adminOnly(c){if(!isAdmin(c))throw new BizError('FORBIDDEN',403);}
const audit=(db,actor,action,id,code='SUCCESS')=>db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) VALUES(?,?,?,?,${now})`).bind(actor,action,String(id),code);
const live=`NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=p.delivery_id)
 AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=p.delivery_id)`;

export async function processingList(c) {
  const before=Number(c.req.query('before')||Number.MAX_SAFE_INTEGER),state=c.req.query('state')||'FAILED';
  if(!Number.isSafeInteger(before)||before<1||!['FAILED','QUARANTINED','RECEIVED','PROCESSING','RETRY_WAIT','QUEUED'].includes(state))throw new BizError('INVALID_FILTER',400);
  return (await c.env.db.prepare(`SELECT p.rowid AS cursor,p.delivery_id AS deliveryId,p.email_id AS emailId,p.account_id AS accountId,
    p.state,p.attempts,p.retry_cycle AS retryCycle,p.last_error_code AS errorCode,p.updated_at AS updatedAt
    FROM mail_processing p WHERE p.rowid<? AND p.state=? AND (?=1 OR p.user_id=?) AND ${live}
    ORDER BY p.rowid DESC LIMIT 30`).bind(before,state,isAdmin(c)?1:0,c.get('user').userId).all()).results;
}
export async function retryProcessing(c,id,input) {
  if(!uuid.test(id)||!Number.isSafeInteger(input.cycle)||input.cycle<0||!['STORAGE_RECOVERED','PARSER_UPDATED','MANUAL_REVIEW'].includes(input.reason))throw new BizError('INVALID_RETRY',400);
  const db=c.env.db,actor=c.get('user').userId;
  const row=await db.prepare(`SELECT p.* FROM mail_processing p WHERE p.delivery_id=? AND (?=1 OR p.user_id=?) AND ${live}`).bind(id,isAdmin(c)?1:0,actor).first();
  if(!row)throw new BizError('NOT_FOUND',404);
  if(!['FAILED','QUARANTINED'].includes(row.state)||row.retry_cycle!==input.cycle)throw new BizError('RETRY_STATE_CHANGED',409);
  const raw=await loadRawDescriptor(c.env.r2,{deliveryId:id,rawKey:row.raw_key});
  if(raw.userId!==row.user_id||raw.accountId!==row.account_id||raw.envelopeTo!==row.envelope_to||raw.envelopeFrom!==row.envelope_from||raw.receivedAt!==row.received_at||raw.rawSize!==row.raw_size)throw new BizError('RAW_IDENTITY_CONFLICT',409);
  if(await c.env.r2.head(`tombstones/${id}.json`))throw new BizError('DELETED',409);
  const changed=await db.batch([
    db.prepare(`UPDATE mail_processing AS p SET state='RECEIVED',retry_cycle=retry_cycle+1,attempts=0,parse_failures=0,
      next_attempt_at=0,lease_epoch=lease_epoch+1,lease_owner=NULL,lease_until=0,last_error_code=NULL,updated_at=${now}
      WHERE delivery_id=? AND retry_cycle=? AND state IN ('FAILED','QUARANTINED') AND ${live}
      AND EXISTS(SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id WHERE a.account_id=p.account_id AND a.user_id=p.user_id
        AND a.is_del=0 AND a.retired_at IS NULL AND u.is_del=0 AND u.retired_at IS NULL AND u.status=0
        AND p.received_at>max(a.retired_through,u.retired_through)) RETURNING retry_cycle`).bind(id,input.cycle),
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT ?,'mail.retry',?,?,${now} WHERE changes()=1`).bind(actor,id,input.reason),
  ]);
  if(!changed[0].results.length)throw new BizError('RETRY_STATE_CHANGED',409);
  // Durable RECEIVED is the outbox. Cron can recover when Queue is unavailable.
  let dispatch='WAITING_FOR_RECOVERY';
  if(c.env.MAIL_QUEUE?.send)try{await c.env.MAIL_QUEUE.send({version:1,kind:'process',deliveryId:id,rawKey:row.raw_key});dispatch='SENT';}catch{}
  return {state:'RECEIVED',retryCycle:input.cycle+1,dispatch};
}
export async function mailboxList(c) {
  const before=positive(c.req.query('before')||Number.MAX_SAFE_INTEGER);
  return (await c.env.db.prepare(`SELECT a.account_id AS accountId,a.email,a.user_id AS userId,a.domain_id AS domainId,
    a.receive_enabled AS receiveEnabled,a.is_del AS deleted,a.retired_at AS retiredAt,d.enabled AS domainEnabled
    FROM account a LEFT JOIN domains d ON d.domain_id=a.domain_id WHERE a.account_id<? AND a.user_id=? ORDER BY a.account_id DESC LIMIT 30`)
    .bind(before,c.get('user').userId).all()).results;
}
export async function setMailbox(c,id,input) {
  const db=c.env.db,actor=c.get('user').userId;id=positive(id);
  if(!['enable','disable','restore'].includes(input.action))throw new BizError('INVALID_ACTION',400);
  const account=await db.prepare('SELECT * FROM account WHERE account_id=? AND user_id=?').bind(id,actor).first();
  if(!account)throw new BizError('NOT_FOUND',404);
  let query;
  if(input.action==='restore') {
    // Old accepted raw may appear later. retired_through remains a permanent fence.
    query=`UPDATE account SET is_del=0,retired_at=NULL,receive_enabled=0 WHERE account_id=? AND user_id=? AND is_del=1
      AND NOT EXISTS(SELECT 1 FROM email e WHERE e.account_id=account.account_id AND e.delete_state='ACTIVE')
      AND NOT EXISTS(SELECT 1 FROM mail_processing p WHERE p.account_id=account.account_id AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=p.delivery_id))`;
  } else {
    query=`UPDATE account SET receive_enabled=${input.action==='enable'?1:0},disabled_at=${input.action==='enable'?'NULL':now}
      WHERE account_id=? AND user_id=? AND is_del=0 AND retired_at IS NULL
      ${input.action==='enable'?"AND EXISTS(SELECT 1 FROM domains d WHERE d.domain_id=account.domain_id AND d.enabled=1 AND d.name=substr(account.email,instr(account.email,'@')+1) COLLATE NOCASE)":''}`;
  }
  const results=await db.batch([db.prepare(query+' RETURNING account_id').bind(id,actor),
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at) SELECT ?,?,?, 'SUCCESS',${now} WHERE changes()=1`).bind(actor,'account.'+input.action,String(id))]);
  if(!results[0].results.length)throw new BizError(input.action==='restore'?'RETIREMENT_CLEANUP_PENDING':'MAILBOX_UNAVAILABLE',409);
  return {accountId:id,receiveEnabled:input.action==='enable'};
}
export async function domainChange(c,input) {
  adminOnly(c);const name=String(input.name||'').toLowerCase();
  if(!Array.isArray(c.env.domain)||!c.env.domain.includes(name)||typeof input.enabled!=='boolean')throw new BizError('DOMAIN_NOT_CONFIGURED',400);
  await c.env.db.batch([c.env.db.prepare('INSERT INTO domains(name,enabled) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled').bind(name,input.enabled?1:0),
    c.env.db.prepare("UPDATE account SET domain_id=(SELECT domain_id FROM domains WHERE name=?) WHERE substr(email,instr(email,'@')+1)=? COLLATE NOCASE").bind(name,name),
    audit(c.env.db,c.get('user').userId,'domain.changed',name,input.enabled?'ENABLED':'DISABLED')]);
}
function filters(input) {
  const fields={sendName:'name',sendEmail:'send_email',toEmail:'to_email',subject:'subject'},where=[],values=[];
  if(!input||typeof input!=='object')throw new BizError('INVALID_FILTER',400);
  for(const [key,column] of Object.entries(fields))if(input[key]) {
    if(typeof input[key]!=='string'||input[key].length>200)throw new BizError('INVALID_FILTER',400);
    const mode=input.type==='eq'?'exact':input.type||'include';if(!['left','include','exact'].includes(mode))throw new BizError('INVALID_FILTER',400);
    where.push(`${column} LIKE ? ESCAPE '\\'`);const text=input[key].replace(/[\\%_]/g,'\\$&');values.push((mode==='include'?'%':'')+text+(mode==='exact'?'':'%'));
  }
  if(input.startTime||input.endTime) {
    if(!/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d:\d\d)?$/.test(input.startTime)||!/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d:\d\d)?$/.test(input.endTime)||input.startTime>input.endTime)throw new BizError('INVALID_FILTER',400);
    where.push('create_time>=? AND create_time<=?');values.push(input.startTime,input.endTime);
  }
  if(!where.length)throw new BizError('FILTER_REQUIRED',400);return {where:where.join(' AND '),values};
}
export async function createBulkDeletion(c,input) {
  filters(input);const db=c.env.db,jobId=crypto.randomUUID(),actor=c.get('user').userId;
  const ceiling=(await db.prepare('SELECT coalesce(max(email_id),0) n FROM email').first()).n;
  await db.batch([db.prepare('INSERT INTO bulk_deletion_runs(job_id,actor_user_id,filters,upper_id) VALUES(?,?,?,?)').bind(jobId,actor,JSON.stringify(input),ceiling),audit(db,actor,'mail.bulk.requested',jobId)]);
  return {jobId,state:'PENDING'};
}
export async function advanceBulkDeletion(db) {
  const run=await db.prepare("SELECT * FROM bulk_deletion_runs WHERE state='PENDING' ORDER BY created_at LIMIT 1").first();if(!run)return;
  try {
  const filter=filters(JSON.parse(run.filters));
  const rows=(await db.prepare(`SELECT email_id FROM email WHERE email_id>? AND email_id<=? AND ${filter.where} ORDER BY email_id LIMIT 20`).bind(run.cursor_id,run.upper_id,...filter.values).all()).results;
  if(rows.length)await requestMailDeletion(db,rows.map(row=>row.email_id),run.actor_user_id,{admin:true});
  await db.prepare(`UPDATE bulk_deletion_runs SET cursor_id=?,requested_count=requested_count+?,state=?,updated_at=${now},error_code=NULL WHERE job_id=? AND cursor_id=? AND state='PENDING'`)
    .bind(rows.at(-1)?.email_id??run.upper_id,rows.length,rows.length<20?'COMPLETE':'PENDING',run.job_id,run.cursor_id).run();
  }catch {
    await db.prepare("UPDATE bulk_deletion_runs SET error_code='DELETE_REGISTRATION_FAILED',updated_at=unixepoch()*1000 WHERE job_id=? AND state='PENDING'").bind(run.job_id).run();
  }
}
export async function operationsStatus(c) {
  adminOnly(c);const db=c.env.db;
  const results=await db.batch([
    db.prepare('SELECT state,count(*) count FROM mail_processing GROUP BY state'),
    db.prepare(`SELECT count(*) expired FROM mail_processing WHERE state='PROCESSING' AND lease_until<=${now}`),
    db.prepare("SELECT state,count(*) count FROM mail_deletion_jobs GROUP BY state"),
    db.prepare('SELECT kind,owner,expires_at AS expiresAt FROM storage_maintenance WHERE singleton=1'),
    db.prepare('SELECT job_name AS jobName,updated_at AS updatedAt,invalid_count AS invalidCount FROM recovery_cursors'),
    db.prepare(`SELECT b.backup_id AS backupId,b.state,b.started_at AS startedAt,b.completed_at AS completedAt,b.error_code AS errorCode,
      coalesce((SELECT t.state FROM backup_offsite_runs t WHERE t.backup_id=b.backup_id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1),'NOT_REPORTED') AS offsiteState,
      (SELECT t.updated_at FROM backup_offsite_runs t WHERE t.backup_id=b.backup_id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS offsiteUpdatedAt
      FROM backup_runs b ORDER BY b.started_at DESC LIMIT 10`),
    db.prepare('SELECT job_id AS jobId,state,requested_count AS requestedCount,updated_at AS updatedAt,error_code AS errorCode FROM bulk_deletion_runs ORDER BY created_at DESC LIMIT 20'),
    db.prepare('SELECT event_id AS eventId,delivery_id AS deliveryId,stage,code,created_at AS createdAt FROM operations_events ORDER BY event_id DESC LIMIT 30'),
    db.prepare('SELECT actor_user_id AS actorUserId,action,target_id AS targetId,result_code AS resultCode,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 30'),
  ]);
  return {processing:results[0].results,expiredLeases:results[1].results[0].expired,deletion:results[2].results,storage:results[3].results[0],
    recovery:results[4].results,backups:results[5].results,bulk:results[6].results,events:results[7].results,audit:results[8].results,
    dlqDepth:null,oldestUnindexedRawAge:null,enabled:{recovery:c.env.MAIL_RECOVERY_ENABLED==='true',deletion:c.env.MAIL_DELETION_ENABLED==='true',purge:c.env.MAIL_PURGE_ENABLED==='true',generationGc:c.env.MAIL_GENERATION_GC_ENABLED==='true'}};
}
