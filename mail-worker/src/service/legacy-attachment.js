import {GetObjectCommand} from '@aws-sdk/client-s3';
import {legacyS3Client} from '../runtime/legacy-s3-client.js';

const LIMIT=25*1024*1024;
const fail=()=>new Error('LEGACY_ATTACHMENT_UNAVAILABLE');
async function bounded(stream,size) {
  if (!stream?.getReader) throw fail();
  const reader=stream.getReader(),bytes=new Uint8Array(size);
  let offset=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(done) break;
      if(!(value instanceof Uint8Array) || offset+value.length>size) throw fail();
      bytes.set(value,offset);offset+=value.length;
    }
    if(offset!==size) throw fail();
    return bytes;
  } catch { await reader.cancel().catch(()=>{});throw fail(); }
  finally {reader.releaseLock();}
}
export async function readLegacyAttachment(env,att) {
  // Never infer an old backend from the newly installed R2 binding or search stores.
  const backend=att.storage_backend==='legacy' ? env.LEGACY_MAIL_STORAGE:att.storage_backend;
  if (!['kv','r2','s3'].includes(backend) || !Number.isSafeInteger(att.size) || att.size<0 || att.size>LIMIT ||
    typeof att.key!=='string' || !/^attachments\/[A-Za-z0-9_.-]+$/.test(att.key) || att.key.length>512) throw fail();
  try {
    if(backend==='kv') {
      const value=await env.kv.get(att.key,{type:'arrayBuffer'});
      if(!value || value.byteLength!==att.size) throw fail();
      return new Uint8Array(value);
    }
    if(backend==='r2') {
      const object=await env.r2.get(att.key);
      if(!object) throw fail();
      if(object.size!==att.size) {await object.body.cancel();throw fail();}
      return await bounded(object.body,att.size);
    }
    const client=legacyS3Client(env);
    try {
      const object=await client.send(new GetObjectCommand({Bucket:env.LEGACY_S3_BUCKET,Key:att.key}));
      const stream=object.Body?.transformToWebStream();
      if(object.ContentLength!==att.size) {await stream?.cancel();throw fail();}
      return await bounded(stream,att.size);
    } finally {client.destroy();}
  } catch {throw fail();}
}
