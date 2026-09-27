import { describeRawObject } from './queue-event.js';
import { assertCurrentLease } from './jobs.js';
import { parseRawMail, PROCESSOR_VERSION } from './mime.js';

const encoder=new TextEncoder();
const hex=buffer=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
async function digest(bytes) { return crypto.subtle.digest('SHA-256',bytes); }

export async function readJobRaw(bucket, lease) {
  let object;
  try { object=await bucket.get(lease.raw_key); }
  catch { throw new Error('STORAGE_UNAVAILABLE'); }
  if (!object) throw new Error('RAW_NOT_FOUND');
  try {
    const descriptor=describeRawObject(object,{rawKey:lease.raw_key,deliveryId:lease.delivery_id,expectedSize:lease.raw_size});
    if (descriptor.userId!==lease.user_id || descriptor.accountId!==lease.account_id ||
        descriptor.envelopeFrom!==lease.envelope_from || descriptor.envelopeTo!==lease.envelope_to ||
        descriptor.receivedAt!==lease.received_at) throw new Error('RAW_IDENTITY_CONFLICT');
  } catch(error) {
    await object.body?.cancel().catch(()=>{});
    throw error;
  }
  const bytes=new Uint8Array(object.size);
  const reader=object.body.getReader();
  let offset=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || offset+value.byteLength>bytes.length) throw new Error('RAW_LENGTH_MISMATCH');
      bytes.set(value,offset); offset+=value.byteLength;
    }
    if (offset!==bytes.length) throw new Error('RAW_LENGTH_MISMATCH');
  } catch(error) {
    await reader.cancel().catch(()=>{});
    throw new Error(error.message==='RAW_LENGTH_MISMATCH' ? 'RAW_LENGTH_MISMATCH':'STORAGE_UNAVAILABLE');
  } finally { reader.releaseLock(); }
  return {bytes,rawSha256:hex(await digest(bytes))};
}

export async function prepareGeneration(db,bucket,lease) {
  if (lease.processor_version!==PROCESSOR_VERSION) throw new Error('PROCESSOR_VERSION_MISMATCH');
  await assertCurrentLease(db,lease);
  const {bytes,rawSha256}=await readJobRaw(bucket,lease);
  const parsed=await parseRawMail(bytes);
  const generation=hex(await digest(encoder.encode(`${PROCESSOR_VERSION}\n${rawSha256}`)));
  const prefix=`derived/${lease.delivery_id}/${generation}`;
  const metadata={deliveryId:lease.delivery_id,generation};
  async function write(key,content,contentType,checkLease=true) {
    if (checkLease) await assertCurrentLease(db,lease);
    const data=typeof content==='string' ? encoder.encode(content):content;
    const checksum=await digest(data), sha256=hex(checksum);
    let object;
    try {
      object=await bucket.put(key,data,{onlyIf:{etagDoesNotMatch:'*'},sha256:checksum,
        customMetadata:metadata,httpMetadata:{contentType,cacheControl:'private, no-store'}});
      if (!object) object=await bucket.head(key);
    } catch { throw new Error('STORAGE_UNAVAILABLE'); }
    if (!object || object.size!==data.byteLength || !object.checksums?.sha256 ||
        hex(object.checksums.sha256)!==sha256 || object.customMetadata?.generation!==generation ||
        object.customMetadata?.deliveryId!==lease.delivery_id) throw new Error('DERIVED_OBJECT_CONFLICT');
    return {key,size:data.byteLength,sha256};
  }
  const html=await write(`${prefix}/body.html`,parsed.html,'text/html; charset=utf-8');
  const text=await write(`${prefix}/body.txt`,parsed.text,'text/plain; charset=utf-8');
  const attachments=[];
  for (const [index,attachment] of parsed.attachments.entries()) {
    const kind=attachment.disposition==='inline' ? 'inline':'attachments';
    // Recheck at bounded batch boundaries, keeping D1 calls below Free limits.
    // Purge must wait the entire old lease window, even after deletion is requested.
    const stored=await write(`${kind}/${lease.delivery_id}/${generation}/${attachment.partId}`,
      attachment.content,'application/octet-stream',index%10===0);
    const {content,...fields}=attachment;
    attachments.push({...fields,...stored,objectKind:kind==='inline' ? 'inline':'attachment'});
  }
  const {html:unusedHtml,text:unusedText,attachments:unusedAttachments,...headers}=parsed;
  const manifest={version:1,deliveryId:lease.delivery_id,generation,processorVersion:PROCESSOR_VERSION,
    rawKey:lease.raw_key,rawSha256,html,text,attachments,...headers};
  const manifestKey=`${prefix}/manifest.json`;
  const stored=await write(manifestKey,JSON.stringify(manifest),'application/json');
  await assertCurrentLease(db,lease);
  return {...manifest,manifestKey,manifestSha256:stored.sha256};
}
