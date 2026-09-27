import {encryptBlob} from './age-stream.mjs';

const identity=(backend,key)=>JSON.stringify([backend,key]);
export async function collectObjects({references,inventory,readObject,snapshotAt,assertHold,signal,executable,recipient,directory,cipherCache,maxObjects=1000000,maxObjectBytes=25*1024*1024}) {
  if(!Number.isSafeInteger(snapshotAt)||snapshotAt<0||!Array.isArray(references))throw new Error('INVALID_OBJECT_COLLECTION');
  const required=new Map(references.map(item=>[identity(item.backend,item.key),item]));
  const selected=new Map(required);
  if(selected.size>maxObjects)throw new Error('SNAPSHOT_REFERENCE_LIMIT');
  // Inventory covers the entire raw/tombstone prefixes, including raw that has
  // not reached D1 yet. Objects created after T are only required if SQL refers
  // to them; this is a recoverable interval, not a cross-service atomic snapshot.
  for await(const item of inventory) {
    signal.throwIfAborted();
    if(item.backend==='r2' && /^(raw|tombstones)\//.test(item.key)) {
      if(!Number.isSafeInteger(item.uploadedAt)||item.uploadedAt<0)throw new Error('INVALID_OBJECT_INVENTORY');
      if(item.uploadedAt<=snapshotAt)selected.set(identity(item.backend,item.key),required.get(identity(item.backend,item.key))??{backend:item.backend,key:item.key,size:null,sha256:null});
    }
    if(selected.size>maxObjects)throw new Error('SNAPSHOT_REFERENCE_LIMIT');
  }
  const objects=[];
  for(const ref of selected.values()) {
    signal.throwIfAborted();await assertHold();
    const object=await readObject(ref.backend,ref.key,signal);
    try {
    if(!object?.body || !Number.isSafeInteger(object.size)||object.size<0||object.size>maxObjectBytes||
      !Number.isSafeInteger(object.uploadedAt)||!object.customMetadata||!object.httpMetadata)throw new Error('BACKUP_OBJECT_MISSING_OR_INVALID');
    if(!required.has(identity(ref.backend,ref.key))&&object.uploadedAt>snapshotAt)throw new Error('BACKUP_OBJECT_CHANGED');
    if(ref.size!==null&&ref.size!==object.size)throw new Error('BACKUP_OBJECT_SIZE_MISMATCH');
    let blob=await encryptBlob({executable,recipient,directory,source:object.body,maxBytes:object.size,signal});
    if(blob.plain.size!==object.size || (ref.sha256!==null&&ref.sha256!==blob.plain.sha256)||
      (object.sha256 && object.sha256!==blob.plain.sha256))throw new Error('BACKUP_OBJECT_HASH_MISMATCH');
    if(cipherCache)blob=await cipherCache.adopt(blob,directory,signal);
    await assertHold();
    objects.push({backend:ref.backend,key:ref.key,uploadedAt:object.uploadedAt,customMetadata:object.customMetadata,httpMetadata:object.httpMetadata,blob});
    } finally {await object?.cancel?.();}
  }
  return objects;
}
