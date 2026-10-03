import { assertCurrentLease, leaseCondition } from './jobs.js';
import { readListMetadata } from './list-metadata.js';

const encoder=new TextEncoder();
const hex=buffer=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
const hash=async text=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));

async function verifyObjects(bucket,lease,manifest) {
  const {manifestKey,manifestSha256,...stored}=manifest;
  const expectedGeneration=await hash(`${lease.processor_version}\n${manifest.rawSha256}`);
  const prefix=`derived/${lease.delivery_id}/${expectedGeneration}`;
  if (manifest.deliveryId!==lease.delivery_id || manifest.rawKey!==lease.raw_key ||
      manifest.processorVersion!==lease.processor_version || manifest.generation!==expectedGeneration ||
      manifestKey!==`${prefix}/manifest.json` || manifest.html?.key!==`${prefix}/body.html` ||
      manifest.text?.key!==`${prefix}/body.txt` || !Array.isArray(manifest.attachments) || manifest.attachments.length>100 ||
      await hash(JSON.stringify(stored))!==manifestSha256) throw new Error('INVALID_GENERATION');
  const seen=new Set();
  for (const attachment of manifest.attachments) {
    const kind=attachment.objectKind==='inline' ? 'inline':'attachments';
    if (!/^part-[1-9]\d*$/.test(attachment.partId) || seen.has(attachment.partId) ||
        attachment.key!==`${kind}/${lease.delivery_id}/${expectedGeneration}/${attachment.partId}`) throw new Error('INVALID_GENERATION');
    seen.add(attachment.partId);
  }
  const objects=[manifest.html,manifest.text,...manifest.attachments,
    {key:manifestKey,sha256:manifestSha256,size:encoder.encode(JSON.stringify(stored)).length}];
  async function verify(expected) {
    let object;
    try { object=await bucket.head(expected.key); }
    catch { throw new Error('STORAGE_UNAVAILABLE'); }
    if (!object || object.size!==expected.size || !object.checksums?.sha256 || hex(object.checksums.sha256)!==expected.sha256 ||
        object.customMetadata?.deliveryId!==lease.delivery_id || object.customMetadata?.generation!==expectedGeneration) throw new Error('GENERATION_INCOMPLETE');
  }
  for(let offset=0;offset<objects.length;offset+=4){
    const results=await Promise.allSettled(objects.slice(offset,offset+4).map(verify));
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }
}

export async function publishGeneration(db,bucket,lease,manifest) {
  const started=Date.now();
  await assertCurrentLease(db,lease);
  await verifyObjects(bucket,lease,manifest);
  const verified=Date.now();
  const list=await readListMetadata(bucket,manifest);
  const gate=`EXISTS (SELECT 1 FROM mail_processing p WHERE ${leaseCondition()})`;
  const guard=[lease.delivery_id,lease.lease_owner,lease.lease_epoch,lease.processor_version];
  const sql=(query,values=[])=>db.prepare(query).bind(...values,...guard);
  const statements=[sql(`INSERT INTO email
    (delivery_id,user_id,account_id,envelope_from,envelope_to,raw_r2_key,raw_size,raw_sha256,received_at,
     storage_version,processing_status,create_time)
    SELECT ?,?,?,?,?,?,?,?,?,'r2-v1','PROCESSING',datetime(?/1000,'unixepoch') WHERE ${gate}
    ON CONFLICT(delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING`,
    [lease.delivery_id,lease.user_id,lease.account_id,lease.envelope_from,lease.envelope_to,
      lease.raw_key,lease.raw_size,manifest.rawSha256,lease.received_at,lease.received_at])];
  // All staging and publication statements share a single transaction. JSON chunks
  // keep parameter and statement counts bounded for up to 100 attachments.
  for (let offset=0; offset<manifest.attachments.length; offset+=20) {
    statements.push(sql(`INSERT INTO attachments
      (email_id,user_id,account_id,key,filename,mime_type,size,disposition,content_id,generation,part_id,sha256,storage_backend,storage_version,object_kind)
      SELECT e.email_id,e.user_id,e.account_id,j.value->>'$.key',j.value->>'$.filename',j.value->>'$.mimeType',
        j.value->>'$.size',j.value->>'$.disposition',j.value->>'$.contentId',?,j.value->>'$.partId',j.value->>'$.sha256','r2','r2-v1',j.value->>'$.objectKind'
      FROM email e,json_each(?) j WHERE e.delivery_id=? AND e.raw_sha256=? AND e.user_id=? AND e.account_id=? AND e.delete_state='ACTIVE' AND e.is_del=0 AND ${gate}
      ON CONFLICT(email_id,generation,part_id) DO NOTHING`,
      [manifest.generation,JSON.stringify(manifest.attachments.slice(offset,offset+20)),lease.delivery_id,manifest.rawSha256,lease.user_id,lease.account_id]));
  }
  statements.push(sql(`UPDATE email SET html_r2_key=?,text_r2_key=?,published_generation=?,processing_status='PROCESSED',
    processed_at=unixepoch()*1000,subject=?,message_id=?,in_reply_to=?,header_from=?,header_to=?,recipient=?,cc=?,bcc=?,
    send_email=?,name=?,to_email=?,snippet=?,code=? WHERE delivery_id=? AND raw_sha256=? AND user_id=? AND account_id=?
      AND delete_state='ACTIVE' AND is_del=0 AND ${gate}`,
    [manifest.html.key,manifest.text.key,manifest.generation,manifest.subject,manifest.messageId,manifest.inReplyTo,
      JSON.stringify(manifest.headerFrom),JSON.stringify(manifest.headerTo),JSON.stringify(manifest.headerTo),
      JSON.stringify(manifest.cc),JSON.stringify(manifest.bcc),manifest.headerFrom?.address || '',manifest.headerFrom?.name || '',
      lease.envelope_to,list.snippet,list.code,lease.delivery_id,manifest.rawSha256,lease.user_id,lease.account_id]));
  statements.push(sql(`UPDATE mail_processing SET state='PROCESSED',
    email_id=(SELECT email_id FROM email WHERE delivery_id=?),lease_owner=NULL,lease_until=0,last_error_code=NULL,updated_at=unixepoch()*1000
    WHERE delivery_id=? AND EXISTS (SELECT 1 FROM email e WHERE e.delivery_id=? AND e.published_generation=? AND e.user_id=? AND e.account_id=? AND e.raw_sha256=? AND e.delete_state='ACTIVE' AND e.is_del=0)
    AND ${gate}`, [lease.delivery_id,lease.delivery_id,lease.delivery_id,manifest.generation,lease.user_id,lease.account_id,manifest.rawSha256]));
  // SQLite has no standalone ASSERT. Evaluate invalid JSON only on guard failure:
  // a statement error rolls back the WHOLE D1 batch, including staged rows.
  statements.push(db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM mail_processing p JOIN email e ON e.email_id=p.email_id
    WHERE p.delivery_id=? AND p.state='PROCESSED' AND p.lease_epoch=? AND e.published_generation=?
      AND e.user_id=p.user_id AND e.account_id=p.account_id AND e.raw_r2_key=p.raw_key AND e.raw_sha256=?
      AND e.delete_state='ACTIVE' AND e.is_del=0
      AND (SELECT COUNT(*) FROM attachments a WHERE a.email_id=e.email_id AND a.generation=?)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN attachments a
        ON a.email_id=e.email_id AND a.generation=e.published_generation AND a.part_id=j.value->>'$.partId'
        WHERE a.att_id IS NULL OR a.key<>j.value->>'$.key' OR a.sha256 IS NOT j.value->>'$.sha256'
          OR a.size IS NOT j.value->>'$.size' OR a.user_id<>p.user_id OR a.account_id<>p.account_id)
  ) THEN 1 ELSE json('PUBLICATION_GUARD_LOST') END`).bind(lease.delivery_id,lease.lease_epoch,manifest.generation,manifest.rawSha256,manifest.generation,manifest.attachments.length,JSON.stringify(manifest.attachments)));
  await db.batch(statements);
  const row=await db.prepare('SELECT email_id FROM mail_processing WHERE delivery_id=?').bind(lease.delivery_id).first();
  console.log(JSON.stringify({stage:'publication-timing',verifyMs:verified-started,publishMs:Date.now()-verified}));
  return {emailId:row.email_id,generation:manifest.generation};
}
