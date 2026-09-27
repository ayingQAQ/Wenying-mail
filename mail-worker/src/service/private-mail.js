import BizError from '../error/biz-error.js';
import { sanitizeMailHtml } from '../processing/html-sanitizer.js';
import { describeRawObject } from '../processing/queue-event.js';
import { readLegacyAttachment } from './legacy-attachment.js';
import { verifiedDownload } from './verified-download.js';
import { backfilledMapping,backfilledBody,backfillSourceMode,backfilledSourceAttachment } from './backfilled-legacy.js';
import { BACKFILLED_LEGACY,checkBackfillObject } from '../processing/legacy-backfill-format.js';

const missing=()=>new BizError('NOT_FOUND',404);
const unavailable=()=>new BizError('CONTENT_UNAVAILABLE',503);
const hex=value=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
export const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function id(value) {
  if (!/^[1-9]\d{0,14}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw missing();
  return Number(value);
}
export async function ownedMail(db,emailId,userId) {
  const row=await db.prepare(`SELECT e.email_id,e.user_id,e.account_id,e.subject,e.name,e.send_email,e.recipient,e.create_time,
    e.unread,e.status,e.folder,e.processing_status,e.storage_version,e.published_generation,e.delivery_id,
    e.raw_r2_key,e.raw_size,e.raw_sha256,e.html_r2_key,e.text_r2_key,e.envelope_from,e.envelope_to,e.received_at,
    CASE WHEN e.storage_version='legacy' THEN e.content ELSE NULL END AS content,
    CASE WHEN e.storage_version='legacy' THEN e.text ELSE NULL END AS text
    FROM email e JOIN account a ON a.account_id=e.account_id
    JOIN user u ON u.user_id=e.user_id WHERE e.email_id=? AND e.user_id=? AND a.user_id=e.user_id
    AND u.status=0 AND u.is_del=0 AND u.retired_at IS NULL AND a.is_del=0 AND a.retired_at IS NULL AND e.is_del=0 AND e.delete_state='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=coalesce(e.delivery_id,'legacy-email-'||e.email_id))
    AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=coalesce(e.delivery_id,'legacy-email-'||e.email_id))`)
    .bind(id(emailId),userId).first();
  if (!row) throw missing();
  return row;
}
function published(row) {
  if (row.storage_version!=='r2-v1' || row.processing_status!=='PROCESSED' ||
    !/^[a-f0-9]{64}$/.test(row.published_generation || '') || !/^[a-f0-9-]{36}$/.test(row.delivery_id || '')) throw unavailable();
}
async function attachments(db,row) {
  return (await db.prepare(`SELECT att_id AS attId,filename,size,mime_type AS mimeType,content_id AS contentId
    FROM attachments WHERE email_id=? AND user_id=? AND account_id=? AND
    ((? IN ('legacy','legacy-r2-v1') AND storage_version='legacy') OR (storage_version='r2-v1' AND generation=?)) ORDER BY att_id LIMIT 100`)
    .bind(row.email_id,row.user_id,row.account_id,row.storage_version,row.published_generation).all()).results;
}
export async function mailDetail(env,emailId,userId) {
  const row=await ownedMail(env.db,emailId,userId);
  return {emailId:row.email_id,subject:row.subject,name:row.name,sendEmail:row.send_email,recipient:row.recipient,
    createTime:row.create_time,unread:row.unread,status:row.status,folder:row.folder,processingStatus:row.processing_status,
    rawAvailable:row.storage_version==='r2-v1' && row.processing_status==='PROCESSED',attList:await attachments(env.db,row)};
}
async function derived(env,row,key,limit,expected) {
  let object;
  try { object=await env.r2.get(key); } catch { throw unavailable(); }
  if (!object) throw unavailable();
  try {
    if (object.size>limit || object.customMetadata?.deliveryId!==row.delivery_id ||
      object.customMetadata?.generation!==row.published_generation || !object.checksums?.sha256 ||
      (expected && (object.size!==expected.size || hex(object.checksums.sha256)!==expected.sha256))) throw unavailable();
    const bytes=new Uint8Array(await object.arrayBuffer());
    if (bytes.length!==object.size || hex(await crypto.subtle.digest('SHA-256',bytes))!==hex(object.checksums.sha256)) throw unavailable();
    return bytes;
  } catch { await object.body?.cancel().catch(()=>{}); throw unavailable(); }
}
async function recheck(env,row,userId) {
  const latest=await ownedMail(env.db,row.email_id,userId);
  if (latest.published_generation!==row.published_generation || latest.storage_version!==row.storage_version) throw unavailable();
}
export async function mailBody(env,emailId,userId,format) {
  if (!['html','text'].includes(format)) throw new BizError('INVALID_FORMAT',400);
  const row=await ownedMail(env.db,emailId,userId);
  const rows=await attachments(env.db,row);
  let content,images=[];
  if (['legacy',BACKFILLED_LEGACY].includes(row.storage_version)) {
    let sourceContent=row[format==='html'?'content':'text'] || '';
    if(row.storage_version===BACKFILLED_LEGACY){
      try{sourceContent=await backfilledBody(env,row,format);}catch{throw unavailable();}
    }
    if (format==='html') {
      const old=(await env.db.prepare("SELECT att_id,key FROM attachments WHERE email_id=? AND user_id=? AND account_id=? AND storage_version='legacy' LIMIT 100")
        .bind(row.email_id,row.user_id,row.account_id).all()).results;
      const resolveLegacyImage=source=>{
        if(typeof source!=='string') return null;
        const key=source.startsWith('{{domain}}') ? source.slice(10):source.startsWith('/attachments/') ? source.slice(1):source;
        const matches=old.filter(att=>att.key===key);
        return matches.length===1 ? `legacy-att-${matches[0].att_id}`:null;
      };
      ({html:content,images}=sanitizeMailHtml(sourceContent,{resolveLegacyImage}));
    }
    else content=sourceContent;
  } else {
    published(row);
    const prefix=`derived/${row.delivery_id}/${row.published_generation}`;
    const manifest=JSON.parse(new TextDecoder().decode(await derived(env,row,`${prefix}/manifest.json`,1024*1024)));
    const expected=manifest[format];
    const key=format==='html' ? row.html_r2_key:row.text_r2_key;
    if (manifest.deliveryId!==row.delivery_id || manifest.generation!==row.published_generation ||
      manifest.rawSha256!==row.raw_sha256 || key!==`${prefix}/body.${format==='html' ? 'html':'txt'}` || expected?.key!==key) throw unavailable();
    content=new TextDecoder().decode(await derived(env,row,key,4*1024*1024,expected));
    images=Array.isArray(manifest.images) ? manifest.images:[];
  }
  const safeImages=images.slice(0,200).flatMap(image=>{
    if (!/^image-[1-9]\d*$/.test(image.id)) return [];
    if (image.kind==='cid') {
      const matches=rows.filter(att=>(att.contentId || '').replace(/^<|>$/g,'')===image.source ||
        (['legacy',BACKFILLED_LEGACY].includes(row.storage_version) && image.source===`legacy-att-${att.attId}`));
      return matches.length===1 ? [{id:image.id,kind:'cid',attId:matches[0].attId}]:[];
    }
    if (image.kind==='remote') {
      try { const url=new URL(image.source); if (url.protocol==='https:' && !url.username && !url.password) return [{id:image.id,kind:'remote',source:url.href}]; } catch {}
    }
    return [];
  });
  await recheck(env,row,userId);
  return {format,content,images:safeImages};
}
export function disposition(filename) {
  const clean=String(filename || 'download').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180).toWellFormed();
  const encoded=encodeURIComponent(clean).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}
export async function mailRaw(env,emailId,userId) {
  const row=await ownedMail(env.db,emailId,userId);
  if (['legacy',BACKFILLED_LEGACY].includes(row.storage_version)) throw missing();
  published(row);
  let object,download;
  try {
    object=await env.r2.get(row.raw_r2_key);
    if(!object)throw unavailable();
    const raw=describeRawObject(object,{rawKey:row.raw_r2_key,deliveryId:row.delivery_id,expectedSize:row.raw_size});
    if(raw.userId!==row.user_id||raw.accountId!==row.account_id||raw.envelopeFrom!==row.envelope_from||
      raw.envelopeTo!==row.envelope_to||raw.receivedAt!==row.received_at)throw unavailable();
    await recheck(env,row,userId);
    download=await verifiedDownload(object,{size:row.raw_size,sha256:row.raw_sha256,finish:()=>recheck(env,row,userId)});
    return new Response(download.body,{headers:{...privateHeaders,'Content-Length':String(object.size),'Content-Type':'application/octet-stream',
      'Content-Disposition':disposition(`message-${row.email_id}.eml`)}});
  }catch(error){
    if(download)await download.cancel().catch(()=>{});else await object?.body?.cancel().catch(()=>{});
    if(error instanceof BizError)throw error;throw unavailable();
  }
}
function raster(bytes) {
  const starts=values=>values.every((value,i)=>bytes[i]===value);
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  const ascii=new TextDecoder('ascii').decode(bytes.slice(0,12));
  if (/^GIF8[79]a/.test(ascii)) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8,12)==='WEBP') return 'image/webp';
  return null;
}
export async function mailAttachment(env,attId,userId,inline=false) {
  const att=await env.db.prepare('SELECT * FROM attachments WHERE att_id=? AND user_id=?').bind(id(attId),userId).first();
  if (!att) throw missing();
  const row=await ownedMail(env.db,att.email_id,userId);
  if (att.account_id!==row.account_id || att.generation!==row.published_generation) throw missing();
  let bytes,sourceRollback=false;
  if(row.storage_version===BACKFILLED_LEGACY){try{sourceRollback=backfillSourceMode(env);}catch{throw unavailable();}}
  if(row.storage_version==='legacy' && att.storage_version==='legacy') {
    try {bytes=await readLegacyAttachment(env,att);} catch {throw unavailable();}
  } else if(sourceRollback) {
    try{bytes=await backfilledSourceAttachment(env,row,att);}catch{throw unavailable();}
  } else {
    const backfilled=row.storage_version===BACKFILLED_LEGACY;
    if(!backfilled)published(row);
    const kind=att.object_kind==='inline' ? 'inline':'attachments';
    if (!backfilled && (att.storage_version!=='r2-v1' || att.storage_backend!=='r2' || !/^part-[1-9]\d*$/.test(att.part_id) ||
      att.key!==`${kind}/${row.delivery_id}/${row.published_generation}/${att.part_id}`)) throw unavailable();
    let object,download;
    try {
      const mapping=backfilled?await backfilledMapping(env,row,`att-${att.att_id}`):null;
      if(backfilled && (att.storage_version!=='legacy'||mapping.size!==att.size||mapping.source_key!==att.key))throw unavailable();
      object=await env.r2.get(mapping?.key??att.key);
      if(backfilled)checkBackfillObject(object,mapping,mapping.source_hash);
      else if(!object||object.size!==att.size||object.customMetadata?.deliveryId!==row.delivery_id||
        object.customMetadata?.generation!==row.published_generation||!object.checksums?.sha256||
        hex(object.checksums.sha256)!==att.sha256)throw unavailable();
      await recheck(env,row,userId);
      download=await verifiedDownload(object,{size:att.size,sha256:mapping?.sha256??att.sha256,prefixLength:inline?12:0,finish:()=>recheck(env,row,userId)});
      const mime=inline?raster(download.prefix):'application/octet-stream';
      if(!mime)throw new BizError('INLINE_TYPE_UNSUPPORTED',415);
      return new Response(download.body,{headers:{...privateHeaders,'Content-Length':String(att.size),'Content-Type':mime,
        'Content-Disposition':inline?'inline':disposition(att.filename),'Content-Security-Policy':"default-src 'none'; sandbox"}});
    }catch(error){
      if(download)await download.cancel().catch(()=>{});else await object?.body?.cancel().catch(()=>{});
      if(error instanceof BizError)throw error;throw unavailable();
    }
  }
  const mime=inline ? raster(bytes):'application/octet-stream';
  if (!mime) throw new BizError('INLINE_TYPE_UNSUPPORTED',415);
  await recheck(env,row,userId);
  return new Response(bytes,{headers:{...privateHeaders,'Content-Type':mime,
    'Content-Disposition':inline ? 'inline':disposition(att.filename),
    'Content-Security-Policy':"default-src 'none'; sandbox"}});
}
