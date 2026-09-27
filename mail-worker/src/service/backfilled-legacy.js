import {backfillKey,readBackfillBytes,hex} from '../processing/legacy-backfill-format.js';
import {readLegacyAttachment} from './legacy-attachment.js';

export function backfillSourceMode(env){
  const mode=env.LEGACY_BACKFILL_READ_MODE??'copy';
  if(!['copy','source'].includes(mode))throw new Error('BACKFILL_READ_MODE_INVALID');
  return mode==='source';
}
async function verifiedSource(bytes,mapping){
  if(bytes.length!==mapping.size||hex(await crypto.subtle.digest('SHA-256',bytes))!==mapping.sha256)throw new Error('BACKFILL_SOURCE_CHANGED');
  return bytes;
}

export async function backfilledMapping(env,row,part) {
  const mapping=await env.db.prepare(`SELECT o.*,j.source_hash FROM legacy_backfill_objects o JOIN legacy_backfill_jobs j ON j.email_id=o.email_id
    WHERE o.email_id=? AND o.part=? AND o.state='VERIFIED' AND j.state='PUBLISHED' AND j.user_id=? AND j.account_id=?`)
    .bind(row.email_id,part,row.user_id,row.account_id).first();
  if(!mapping||mapping.key!==backfillKey(row.email_id,mapping.source_hash,part))throw new Error('BACKFILL_UNAVAILABLE');
  return mapping;
}
export async function backfilledBody(env,row,format) {
  const mapping=await backfilledMapping(env,row,format);
  if(backfillSourceMode(env)){
    const source=await env.db.prepare(`SELECT ${format==='html'?'content':'text'} AS body FROM email WHERE email_id=? AND user_id=? AND account_id=?`)
      .bind(row.email_id,row.user_id,row.account_id).first();
    if(!source||source.body!==null&&typeof source.body!=='string'||mapping.size>4*1024*1024)throw new Error('BACKFILL_SOURCE_CHANGED');
    const value=source.body??'';
    if(!value.isWellFormed())throw new Error('BACKFILL_SOURCE_CHANGED');
    await verifiedSource(new TextEncoder().encode(value),mapping);
    return value;
  }
  const bytes=await readBackfillBytes(await env.r2.get(mapping.key),mapping,mapping.source_hash,4*1024*1024);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export async function backfilledSourceAttachment(env,row,att){
  const mapping=await backfilledMapping(env,row,`att-${att.att_id}`);
  if(att.storage_version!=='legacy'||mapping.source_key!==att.key||mapping.size!==att.size||!['kv','r2','s3'].includes(mapping.source_backend))
    throw new Error('BACKFILL_SOURCE_CHANGED');
  return verifiedSource(await readLegacyAttachment(env,{...att,storage_backend:mapping.source_backend}),mapping);
}
