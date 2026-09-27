import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {downloadSnapshot} from './offsite-transfer.mjs';
import {reviewRetention} from './retention-plan.mjs';
export function offsiteInventoryHash(store,rows){
  if(!/^[a-f0-9]{64}$/.test(store.targetIdentitySha256))throw Error('OFFSITE_TARGET_IDENTITY_REQUIRED');
  return createHash('sha256').update(JSON.stringify({target:store.targetIdentitySha256,rows})).digest('hex');
}

// This is a review, not a reusable delete authorization. The executor must hold
// the shared write lock; orphan blobs can belong to an unfinished upload.
export async function reviewOffsiteRetention({directory,store,maxSnapshots=1000,maxDownloadBytes=12*1024*1024*1024,...options}){
  const signal=options.signal;
  if(!signal||!Number.isSafeInteger(maxSnapshots)||maxSnapshots<1||maxSnapshots>1000||!Number.isSafeInteger(maxDownloadBytes)||maxDownloadBytes<1||maxDownloadBytes>12*1024*1024*1024)throw Error('INVALID_OFFSITE_REVIEW_LIMIT');
  signal.throwIfAborted();await store.begin(signal);
  const before=await store.inventory(signal),ids=[];
  for(const row of before)if(row.key.startsWith('snapshots/')){
    const match=/^snapshots\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/transport\.json$/.exec(row.key);
    if(!match||ids.length>=maxSnapshots)throw Error('OFFSITE_REVIEW_INVENTORY_INVALID');ids.push(match[1]);
  }
  directory=resolve(directory);await mkdir(directory,{mode:0o700});let downloadedBytes=0;
  const bounded={begin:s=>store.begin(s),async get(key,s){
    const object=await store.get(key,s);if(!object)return null;
    downloadedBytes+=object.size;
    if(!Number.isSafeInteger(object.size)||object.size<0||downloadedBytes>maxDownloadBytes){object.cancel();throw Error('OFFSITE_REVIEW_DOWNLOAD_LIMIT');}
    return object;
  }};
  for(const snapshotId of ids)await downloadSnapshot({snapshotId,directory:join(directory,snapshotId),store:bounded,signal});
  const referenced=new Set();
  const review=await reviewRetention({...options,directory,maxSnapshots,onVerified:verified=>{
    for(const blob of [verified.manifestBlob,verified.manifest.database.blob,...verified.manifest.objects.map(o=>o.blob)])referenced.add('blobs/'+blob.file);
  }});
  await store.begin(signal);const after=await store.inventory(signal);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('OFFSITE_REVIEW_INVENTORY_CHANGED');
  return {...review,remoteInventorySha256:offsiteInventoryHash(store,after),targetIdentitySha256:store.targetIdentitySha256,downloadedBytes,
    unclaimedRemoteBlobs:after.filter(row=>row.key.startsWith('blobs/')&&!referenced.has(row.key)).map(row=>row.key),
    deletionAllowed:false,requiresExclusiveRevalidation:true,unclaimedBlobsMayBeUploading:true};
}
