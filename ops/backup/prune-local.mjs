import {mkdir,readdir,lstat,rename,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {lockCollection,assertCollectionLock,releaseCollectionLock} from './collection-lock.mjs';
import {reviewRetention} from './retention-plan.mjs';
const fail=()=>{throw new Error('LOCAL_PRUNE_REFUSED');};
// Local snapshot directory entries only; cache/remote blobs are never deleted.
// Old snapshots are atomically retired before unlinking individual known files.
export async function pruneLocalSnapshots({directory,catalogSha256,...options}) {
  if(!/^[a-f0-9]{64}$/.test(catalogSha256))fail();directory=resolve(directory);
  const lock=await lockCollection(directory),files=new Map(),retired=join(directory,'.retired');
  try {
    try{const stat=await lstat(retired);if(!stat.isDirectory()||stat.isSymbolicLink()||(await readdir(retired)).length)fail();}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const plan=await reviewRetention({...options,directory,collectionLock:lock,onVerified:({manifest,manifestBlob})=>{
      files.set(manifest.snapshotId,new Set(['complete.json',manifestBlob.file,manifest.database.blob.file,...manifest.objects.map(object=>object.blob.file)]));
    }});
    if(plan.catalogSha256!==catalogSha256||plan.incomplete.length)fail();
    // Check every candidate before any retirement. Unknown files are never swept.
    for(const id of plan.removalCandidates) {
      const entries=await readdir(join(directory,id),{withFileTypes:true}),expected=files.get(id);
      if(entries.length!==expected.size||entries.some(entry=>!entry.isFile()||entry.isSymbolicLink()||!expected.has(entry.name)))fail();
    }
    if(!plan.removalCandidates.length)return {removed:[],kept:plan.keep,cachePruned:false,remotePruned:false};
    await mkdir(retired,{recursive:true,mode:0o700});const removed=[];
    for(const id of plan.removalCandidates) {
      options.signal?.throwIfAborted();await assertCollectionLock(lock,directory);
      const source=join(directory,id),target=join(retired,id);
      const stat=await lstat(source);if(!stat.isDirectory()||stat.isSymbolicLink())fail();
      try{await lstat(target);fail();}catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(source,target);
      for(const file of files.get(id)) {
        options.signal?.throwIfAborted();await assertCollectionLock(lock,directory);
        const path=join(target,file),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail();await unlink(path);
      }
      await rmdir(target);removed.push(id);
    }
    await rmdir(retired);return {removed,kept:plan.keep,cachePruned:false,remotePruned:false};
  }finally{await releaseCollectionLock(lock);}
}
