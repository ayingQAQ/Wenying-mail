import {mkdir,open} from 'node:fs/promises';import {resolve,join,sep} from 'node:path';
import {reviewOffsiteRetention,offsiteInventoryHash} from './offsite-retention.mjs';
export async function pruneOffsite({store,directory,runDirectory,catalogSha256,inventorySha256,target,...options}){
  if(![catalogSha256,inventorySha256].every(s=>/^[a-f0-9]{64}$/.test(s)))throw Error('OFFSITE_PRUNE_REFUSED');
  directory=resolve(directory);runDirectory=resolve(runDirectory);
  const normalized=p=>(process.platform==='win32'?p.toLowerCase():p)+sep;
  if(normalized(directory).startsWith(normalized(runDirectory))||normalized(runDirectory).startsWith(normalized(directory)))throw Error('OFFSITE_PRUNE_PATH_CONFLICT');
  const signal=options.signal;signal.throwIfAborted();await mkdir(runDirectory,{mode:0o700});
  const journal=await open(join(runDirectory,'prune-journal.jsonl'),'wx',0o600);
  const record=async event=>{await journal.writeFile(JSON.stringify({at:Date.now(),...event})+'\n');await journal.sync();};
  try{
    await record({phase:'PREPARED',target,catalogSha256,inventorySha256});await store.begin(signal);
    const result=await store.withWriteLock(async lock=>{
      await store.assertPrunable(signal);
      const review=await reviewOffsiteRetention({...options,directory,store});
      if(review.catalogSha256!==catalogSha256||review.remoteInventorySha256!==inventorySha256||review.incomplete.length)throw Error('OFFSITE_PRUNE_PLAN_CHANGED');
      const before=await store.inventory(signal);if(offsiteInventoryHash(store,before)!==inventorySha256)throw Error('OFFSITE_PRUNE_PLAN_CHANGED');
      const keys=[...review.removalCandidates.map(id=>`snapshots/${id}/transport.json`),...review.unreferencedBlobCandidates.map(file=>'blobs/'+file)];
      const rows=new Map(before.map(row=>[row.key,row]));if(new Set(keys).size!==keys.length||keys.some(key=>!rows.has(key)))throw Error('OFFSITE_PRUNE_PLAN_INVALID');
      await record({phase:'PLAN_VERIFIED',keep:review.keep,remove:keys.map(key=>rows.get(key)),unclaimedPreserved:review.unclaimedRemoteBlobs});
      if(keys.length)lock.publicationStarted(); // Also fences uncertain deletion.
      for(const key of keys){
        signal.throwIfAborted();await record({phase:'DELETE_INTENT',key,etag:rows.get(key).etag});
        await store.remove(key,rows.get(key).etag,signal);await record({phase:'DELETE_CONFIRMED',key});
      }
      const removed=new Set(keys),expected=before.filter(row=>!removed.has(row.key));
      await store.begin(signal);await store.assertPrunable(signal);
      if(JSON.stringify(await store.inventory(signal))!==JSON.stringify(expected))throw Error('OFFSITE_PRUNE_INVENTORY_MISMATCH');
      await record({phase:'PRUNE_VERIFIED',removed:keys.length});lock.publicationVerified();
      return {removedSnapshots:review.removalCandidates,removedBlobs:review.unreferencedBlobCandidates,kept:review.keep,unclaimedBlobsPreserved:review.unclaimedRemoteBlobs,remotePruned:true};
    },signal);
    await record({phase:'RUN_COMPLETE',report:result});return result;
  }catch{try{await record({phase:'RUN_FAILED',code:signal.aborted?'OPERATION_ABORTED':'OFFSITE_PRUNE_FAILED'});}catch{}throw Error('OFFSITE_PRUNE_FAILED');}
  finally{await journal.close();}
}
