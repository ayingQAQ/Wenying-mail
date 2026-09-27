import {mkdir,open,lstat,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const owned=new WeakMap();
export async function lockCollection(directory) {
  directory=resolve(directory);await mkdir(directory,{recursive:true,mode:0o700});
  const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('INVALID_COLLECTION_ROOT');
  const path=join(directory,'.collection-lock'),file=await open(path,'wx',0o600),token=randomUUID(),lock={};
  try{await file.writeFile(token);await file.sync();}catch(error){await file.close();throw error;}
  owned.set(lock,{directory,path,file,token});return lock;
}
export async function assertCollectionLock(lock,directory) {
  const state=owned.get(lock);if(!state||state.directory!==resolve(directory))throw new Error('COLLECTION_LOCK_LOST');
  const file=await open(state.path,'r');try{const bytes=Buffer.alloc(37),{bytesRead}=await file.read(bytes,0,37,0);
    if(bytes.subarray(0,bytesRead).toString()!==state.token)throw new Error('COLLECTION_LOCK_LOST');
  }finally{await file.close();}
}
export async function releaseCollectionLock(lock) {
  const state=owned.get(lock);if(!state)return;
  try{await assertCollectionLock(lock,state.directory);await state.file.close();await unlink(state.path);}
  finally{owned.delete(lock);await state.file.close().catch(()=>{});}
}
