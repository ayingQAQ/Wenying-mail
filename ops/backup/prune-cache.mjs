import {resolve} from 'node:path';
import {openCipherCache} from './cipher-cache.mjs';
import {lockCollection,releaseCollectionLock,assertCollectionLock} from './collection-lock.mjs';
import {reviewRetention} from './retention-plan.mjs';
export async function pruneCipherCache({directory,cache,key,recipient,catalogSha256,...options}) {
  if(!/^[a-f0-9]{64}$/.test(catalogSha256))throw new Error('CACHE_PRUNE_REFUSED');
  directory=resolve(directory);let lock;
  // Match the backup writer lock order to avoid conflicting maintenance.
  const store=await openCipherCache({root:cache,key,recipient});
  try {
    lock=await lockCollection(directory);const live=new Set();
    const plan=await reviewRetention({...options,directory,collectionLock:lock,onVerified:({manifest,manifestBlob})=>{
      for(const blob of [manifestBlob,manifest.database.blob,...manifest.objects.map(object=>object.blob)])live.add(blob.file);
    }});
    if(plan.catalogSha256!==catalogSha256||plan.incomplete.length||plan.retiredPending)throw new Error('CACHE_PRUNE_REFUSED');
    const result=await store.collectGarbage(live,options.signal,()=>assertCollectionLock(lock,directory));
    return {...result,snapshotsRemoved:false,remotePruned:false};
  }finally{try{if(lock)await releaseCollectionLock(lock);}finally{await store.close();}}
}
