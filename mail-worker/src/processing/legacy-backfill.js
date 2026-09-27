import {acquireStorageLock,assertStorageLock,releaseStorageLock} from './storage-lock.js';
import {readLegacyAttachment} from '../service/legacy-attachment.js';
import {BACKFILLED_LEGACY,backfillKey,hex,checkBackfillObject,readBackfillBytes} from './legacy-backfill-format.js';

const encoder=new TextEncoder(),now='unixepoch()*1000';
const digest=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
const attachmentFields=['att_id','user_id','email_id','account_id','key','size','filename','mime_type','content_id',
  'disposition','related','encoding','status','type','storage_backend','storage_version','generation'];
const eligible=`e.storage_version='legacy' AND e.delete_state='ACTIVE' AND e.is_del=0
  AND e.delivery_id IS NULL AND e.raw_r2_key IS NULL AND e.published_generation IS NULL
  AND EXISTS(SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id WHERE a.account_id=e.account_id
    AND a.user_id=e.user_id AND a.is_del=0 AND a.retired_at IS NULL AND u.is_del=0 AND u.retired_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id='legacy-email-'||e.email_id)
  AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=e.email_id)`;

async function source(env,emailId) {
  const row=await env.db.prepare(`SELECT e.email_id,e.user_id,e.account_id,e.content,e.text FROM email e WHERE e.email_id=? AND ${eligible}`).bind(emailId).first();
  if(!row)throw new Error('BACKFILL_SOURCE_UNAVAILABLE');
  const attachments=(await env.db.prepare(`SELECT ${attachmentFields.join(',')} FROM attachments WHERE email_id=? ORDER BY att_id LIMIT 101`).bind(emailId).all()).results;
  if(attachments.length>100)throw new Error('BACKFILL_SOURCE_LIMIT');
  for(const att of attachments){
    const backend=att.storage_backend==='legacy'?env.LEGACY_MAIL_STORAGE:att.storage_backend;
    if(att.user_id!==row.user_id||att.account_id!==row.account_id||att.storage_version!=='legacy'||att.generation!==null||
      !['kv','r2','s3'].includes(backend)||!Number.isSafeInteger(att.size)||att.size<0||att.size>25*1024*1024||
      !/^attachments\/[A-Za-z0-9_.-]+$/.test(att.key)||att.key.length>512)throw new Error('BACKFILL_SOURCE_INVALID');
  }
  const body={};
  for(const [part,column] of [['html','content'],['text','text']]){
    if(row[column]!==null&&(typeof row[column]!=='string'||!row[column].isWellFormed()))throw new Error('BACKFILL_SOURCE_INVALID');
    body[part]=encoder.encode(row[column]??'');if(body[part].length>4*1024*1024)throw new Error('BACKFILL_SOURCE_LIMIT');
  }
  const sourceHash=await digest(encoder.encode(JSON.stringify({emailId,userId:row.user_id,accountId:row.account_id,
    content:row.content===null?null:await digest(body.html),text:row.text===null?null:await digest(body.text),
    attachments,legacyBackend:attachments.some(att=>att.storage_backend==='legacy')?env.LEGACY_MAIL_STORAGE:null})));
  return {row,attachments,body,sourceHash};
}

function guard(db,lock,snapshot) {
  const {row,attachments}=snapshot;
  // Compare source inside the publication transaction, including NUL-bearing text.
  // User read/star/folder state is deliberately not rewritten or part of this gate.
  return db.prepare(`SELECT CASE WHEN
    EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE' AND owner=? AND expires_at>${now})
    AND EXISTS(SELECT 1 FROM email e WHERE e.email_id=? AND e.user_id=? AND e.account_id=? AND e.content IS ? AND e.text IS ? AND ${eligible})
    AND (SELECT count(*) FROM attachments WHERE email_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.email_id=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE
      ${attachmentFields.map(field=>`a.${field} IS json_extract(j.value,'$.${field}')`).join(' AND ')}))
    THEN 1 ELSE json('BACKFILL_GUARD_LOST') END`).bind(lock.owner,row.email_id,row.user_id,row.account_id,row.content,row.text,
      row.email_id,attachments.length,row.email_id,JSON.stringify(attachments));
}

// One invocation copies at most a small number of objects for one email. The
// persistent cursor advances only with publication. No scheduler enables this.
export async function backfillLegacyBatch(env,{writersStopped=false,maxObjects=2}={}) {
  if(writersStopped!==true||!Number.isInteger(maxObjects)||maxObjects<1||maxObjects>10)throw new Error('BACKFILL_OFFLINE_REQUIRED');
  const lock=await acquireStorageLock(env.db,'PURGE');if(!lock)return {busy:true};
  try {
    await env.db.prepare(`INSERT OR IGNORE INTO legacy_backfill_runs(singleton,upper_id)
      SELECT 1,coalesce(max(email_id),0) FROM email`).run();
    const run=await env.db.prepare('SELECT upper_id,cursor_id FROM legacy_backfill_runs WHERE singleton=1').first();
    if(!Number.isSafeInteger(run.upper_id)||run.upper_id<0||run.upper_id>999999999999999)throw new Error('BACKFILL_SOURCE_INVALID');
    const next=await env.db.prepare(`SELECT email_id FROM email WHERE email_id>? AND email_id<=? AND storage_version='legacy'
      AND delete_state='ACTIVE' AND is_del=0 ORDER BY email_id LIMIT 1`).bind(run.cursor_id,run.upper_id).first();
    if(!next){
      await assertStorageLock(env.db,lock);
      await env.db.prepare('UPDATE legacy_backfill_runs SET cursor_id=upper_id WHERE singleton=1').run();
      return {complete:true,cursor:run.upper_id};
    }
    const snapshot=await source(env,next.email_id),{row,attachments,body,sourceHash}=snapshot;
    const count=attachments.length+2;
    await env.db.batch([guard(env.db,lock,snapshot),env.db.prepare(`INSERT OR IGNORE INTO legacy_backfill_jobs
      (email_id,user_id,account_id,source_hash,object_count,lease_until) VALUES(?,?,?,?,?,?)`).bind(row.email_id,row.user_id,row.account_id,sourceHash,count,lock.expires_at),
      env.db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM legacy_backfill_jobs WHERE email_id=? AND user_id=? AND account_id=?
        AND source_hash=? AND object_count=? AND state='COPYING') THEN 1 ELSE json('BACKFILL_SOURCE_CHANGED') END`)
        .bind(row.email_id,row.user_id,row.account_id,sourceHash,count),
      env.db.prepare(`UPDATE legacy_backfill_jobs SET lease_until=?,updated_at=${now} WHERE email_id=?`).bind(lock.expires_at,row.email_id)]);
    const parts=[{part:'html',backend:'d1',sourceKey:`email:${row.email_id}:content`,bytes:body.html},
      {part:'text',backend:'d1',sourceKey:`email:${row.email_id}:text`,bytes:body.text},
      ...attachments.map(att=>({part:`att-${att.att_id}`,backend:att.storage_backend==='legacy'?env.LEGACY_MAIL_STORAGE:att.storage_backend,sourceKey:att.key,att}))];
    let copied=0;
    for(const part of parts){
      let mapping=await env.db.prepare('SELECT * FROM legacy_backfill_objects WHERE email_id=? AND part=?').bind(row.email_id,part.part).first();
      const key=backfillKey(row.email_id,sourceHash,part.part);
      if(mapping&&(mapping.key!==key||mapping.source_key!==part.sourceKey||mapping.source_backend!==part.backend))throw new Error('BACKFILL_SOURCE_CHANGED');
      if(mapping?.state==='VERIFIED')continue;
      if(copied>=maxObjects)break;
      const bytes=part.bytes??await readLegacyAttachment(env,part.att),sha256=await digest(bytes);
      if(mapping&&(mapping.size!==bytes.length||mapping.sha256!==sha256))throw new Error('BACKFILL_SOURCE_CHANGED');
      mapping??={email_id:row.email_id,part:part.part,source_backend:part.backend,source_key:part.sourceKey,key,size:bytes.length,sha256};
      await env.db.batch([guard(env.db,lock,snapshot),env.db.prepare(`INSERT OR IGNORE INTO legacy_backfill_objects
        (email_id,part,source_backend,source_key,key,size,sha256) VALUES(?,?,?,?,?,?,?)`)
        .bind(mapping.email_id,mapping.part,mapping.source_backend,mapping.source_key,key,mapping.size,sha256)]);
      await assertStorageLock(env.db,lock);
      await env.r2.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:Uint8Array.from(sha256.match(/../g),v=>parseInt(v,16)),
        customMetadata:{emailid:String(row.email_id),sourcehash:sourceHash,part:part.part},httpMetadata:{contentType:'application/octet-stream',cacheControl:'private, no-store'}});
      await readBackfillBytes(await env.r2.get(key),mapping,sourceHash,25*1024*1024);
      await env.db.batch([guard(env.db,lock,snapshot),env.db.prepare("UPDATE legacy_backfill_objects SET state='VERIFIED' WHERE email_id=? AND part=? AND key=? AND sha256=?")
        .bind(row.email_id,part.part,key,sha256)]);
      copied++;
    }
    const mappings=(await env.db.prepare('SELECT * FROM legacy_backfill_objects WHERE email_id=? ORDER BY part').bind(row.email_id).all()).results;
    if(mappings.length!==count||mappings.some(item=>item.state!=='VERIFIED')||parts.some(part=>!mappings.some(item=>item.part===part.part)))
      return {emailId:row.email_id,copied,published:false,cursor:run.cursor_id};
    for(const mapping of mappings){await assertStorageLock(env.db,lock);checkBackfillObject(await env.r2.head(mapping.key),mapping,sourceHash);}
    await env.db.batch([guard(env.db,lock,snapshot),
      env.db.prepare(`UPDATE email SET storage_version=? WHERE email_id=?`).bind(BACKFILLED_LEGACY,row.email_id),
      env.db.prepare(`UPDATE legacy_backfill_jobs SET state='PUBLISHED',lease_until=0,updated_at=${now} WHERE email_id=? AND source_hash=?`).bind(row.email_id,sourceHash),
      env.db.prepare('UPDATE legacy_backfill_runs SET cursor_id=? WHERE singleton=1 AND cursor_id=?').bind(row.email_id,run.cursor_id),
      env.db.prepare(`INSERT INTO audit_logs(action,target_id,result_code,created_at) VALUES('mail.legacy.backfill',?,'VERIFIED',${now})`).bind(String(row.email_id))]);
    return {emailId:row.email_id,copied,published:true,cursor:row.email_id};
  } finally {await releaseStorageLock(env.db,lock);}
}
