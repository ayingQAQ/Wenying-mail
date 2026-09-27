export const BACKFILLED_LEGACY = 'legacy-r2-v1';
export const hex = bytes => Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,'0')).join('');
export const legacyPart = part => /^(?:html|text|att-[1-9]\d{0,14})$/.test(part);
export function backfillKey(emailId,sourceHash,part) {
  if(!Number.isSafeInteger(emailId)||emailId<1||emailId>999999999999999||!/^[a-f0-9]{64}$/.test(sourceHash)||!legacyPart(part))
    throw new Error('INVALID_BACKFILL_IDENTITY');
  return `legacy/${emailId}/${sourceHash}/${part}`;
}
export function checkBackfillObject(object,mapping,sourceHash) {
  if(mapping.key!==backfillKey(mapping.email_id,sourceHash,mapping.part)||!Number.isSafeInteger(mapping.size)||mapping.size<0||
    mapping.size>25*1024*1024||!/^[a-f0-9]{64}$/.test(mapping.sha256)||!object||object.size!==mapping.size||
    !object.checksums?.sha256||hex(object.checksums.sha256)!==mapping.sha256||
    object.customMetadata?.emailid!==String(mapping.email_id)||object.customMetadata?.sourcehash!==sourceHash||
    object.customMetadata?.part!==mapping.part)throw new Error('BACKFILL_OBJECT_CONFLICT');
}
export function checkBackfillMetadata(key,metadata) {
  const match=/^legacy\/([1-9]\d{0,14})\/([a-f0-9]{64})\/(html|text|att-[1-9]\d{0,14})$/.exec(key);
  if(!match||metadata?.emailid!==match[1]||metadata?.sourcehash!==match[2]||metadata?.part!==match[3])
    throw new Error('BACKUP_OBJECT_METADATA_MISMATCH');
}
export async function readBackfillBytes(object,mapping,sourceHash,limit) {
  try {
    checkBackfillObject(object,mapping,sourceHash);
    if(mapping.size>limit)throw new Error('BACKFILL_OBJECT_CONFLICT');
    // Bound by the recorded length, rather than trusting arrayBuffer allocation.
    const bytes=new Uint8Array(mapping.size),reader=object.body.getReader();let offset=0;
    try {
      for(;;){const {done,value}=await reader.read();if(done)break;
        if(!(value instanceof Uint8Array)||offset+value.length>bytes.length)throw new Error('BACKFILL_OBJECT_CONFLICT');
        bytes.set(value,offset);offset+=value.length;
      }
      if(offset!==bytes.length||hex(await crypto.subtle.digest('SHA-256',bytes))!==mapping.sha256)throw new Error('BACKFILL_OBJECT_CONFLICT');
      return bytes;
    } catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
  } catch(error){await object?.body?.cancel().catch(()=>{});throw error;}
}
