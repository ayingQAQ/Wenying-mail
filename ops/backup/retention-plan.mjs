import {opendir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyBackup} from './restore.mjs';
import {planRetention} from './manifest.mjs';
import {assertCollectionLock} from './collection-lock.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Read-only review. This inventory cannot authorize deletion: an offline scan
// has no writer lock, and incomplete candidates may still gain references.
export async function reviewRetention({directory,maxSnapshots=1000,collectionLock,onVerified,...options}) {
  directory=resolve(directory);
  if(!Number.isSafeInteger(maxSnapshots)||maxSnapshots<1||maxSnapshots>10000)throw new Error('INVALID_RETENTION_LIMIT');
  const root=await lstat(directory);
  if(!root.isDirectory()||root.isSymbolicLink())throw new Error('INVALID_RETENTION_ROOT');
  const names=[],snapshots=[],incomplete=[];let retiredPending=false;
  for await(const entry of await opendir(directory)) {
    options.signal?.throwIfAborted();
    if(entry.name==='.collection-lock'&&collectionLock){await assertCollectionLock(collectionLock,directory);continue;}
    if(entry.name==='.retired'&&entry.isDirectory()&&!entry.isSymbolicLink()) {
      for await(const child of await opendir(join(directory,'.retired'))){retiredPending=true;break;}continue;
    }
    if(!uuid.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())throw new Error('UNEXPECTED_RETENTION_ENTRY');
    names.push(entry.name);if(names.length>maxSnapshots)throw new Error('RETENTION_LIMIT');
  }
  names.sort();
  for(const name of names) {
    options.signal?.throwIfAborted();const path=join(directory,name);
    let marker;
    try{marker=await lstat(join(path,'complete.json'));}catch(error){if(error.code==='ENOENT'){incomplete.push(name);continue;}throw error;}
    if(!marker.isFile()||marker.isSymbolicLink())throw new Error('INVALID_RETENTION_MARKER');
    const verified=await verifyBackup({...options,directory:path});
    if(verified.manifest.snapshotId!==name)throw new Error('RETENTION_IDENTITY_MISMATCH');
    snapshots.push({complete:true,manifest:verified.manifest,manifestBlob:verified.manifestBlob});
    onVerified?.(verified);
  }
  const plan=planRetention(snapshots);
  // Fingerprint the exact checked catalog for review, never a reusable delete token.
  const catalog=snapshots.map(item=>[item.manifest.snapshotId,item.manifestBlob.cipher.sha256]);
  return {version:1,policy:{daily:30,monthly:12,timeZone:'UTC'},verifiedSnapshots:snapshots.length,
    catalogSha256:createHash('sha256').update(JSON.stringify({catalog,incomplete,retiredPending})).digest('hex'),
    keep:plan.keep,removalCandidates:plan.remove,unreferencedBlobCandidates:plan.unreferenced,incomplete,
    retiredPending,deletionAllowed:false,requiresExclusiveRevalidation:true};
}
