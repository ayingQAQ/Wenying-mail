import {mkdir,open,lstat,link,unlink,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {validateBlob} from './manifest.mjs';
const fail=()=>{throw new Error('CIPHER_CACHE_FAILED');};
const magic=Buffer.from('MCACHE01');
async function directory(path){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail();}
async function checkFile(path,expected,signal) {
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.size)fail();
  const digest=createHash('sha256');let size=0;
  for await(const chunk of createReadStream(path)){signal?.throwIfAborted();size+=chunk.length;if(size>expected.size)fail();digest.update(chunk);}
  if(size!==expected.size||digest.digest('hex')!==expected.sha256)fail();
}
async function readIndex(path) {
  const file=await open(path,'r');try {
    const bytes=Buffer.alloc(65537);let size=0;
    while(size<bytes.length){const result=await file.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>65536)fail();return bytes.subarray(0,size);
  }finally{await file.close();}
}

// Public-key-only backup runner: local cache indexes use a separate symmetric
// key, never the offline age identity. Snapshot files remain normal UUID.age
// entries and can be copied/restored without this cache or its index key.
export async function openCipherCache({root,key,recipient}) {
  if(typeof key!=='string'||! /^[a-f0-9]{64}$/.test(key)||! /^age1[0-9a-z]{58}$/.test(recipient))fail();
  root=resolve(root);await directory(root);await directory(join(root,'blobs'));await directory(join(root,'index'));
  const secret=Buffer.from(key,'hex'),lockPath=join(root,'.writer-lock');
  const lock=await open(lockPath,'wx',0o600);const lockId=randomUUID();
  try{await lock.writeFile(lockId);await lock.sync();}catch(error){await lock.close();throw error;}
  let closed=false,tail=Promise.resolve();
  function decode(encrypted,id) {
    if(encrypted.length<36||!encrypted.subarray(0,8).equals(magic))fail();
    const decipher=createDecipheriv('aes-256-gcm',secret,encrypted.subarray(8,20));decipher.setAAD(Buffer.from('mail-cipher-cache-v1:'+id));decipher.setAuthTag(encrypted.subarray(20,36));
    const value=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(36)),decipher.final()]).toString('utf8'));
    if(value.version!==1||!/^age1[0-9a-z]{58}$/.test(value.recipient)||Object.keys(value).sort().join(',')!=='blob,recipient,version')fail();
    validateBlob(value.blob);
    if(createHmac('sha256',secret).update(JSON.stringify([value.recipient,value.blob.plain.size,value.blob.plain.sha256])).digest('hex')!==id)fail();
    return value;
  }
  async function adopt(blob,snapshot,signal) {
    if(closed)fail();signal?.throwIfAborted();validateBlob(blob);snapshot=resolve(snapshot);
    if(snapshot===root)fail();
    try{await lstat(join(snapshot,'complete.json'));fail();}catch(error){if(error.code!=='ENOENT')throw error;}
    const candidate=join(snapshot,blob.file);await checkFile(candidate,blob.cipher,signal);
    const id=createHmac('sha256',secret).update(JSON.stringify([recipient,blob.plain.size,blob.plain.sha256])).digest('hex');
    const indexPath=join(root,'index',id+'.idx'),aad=Buffer.from('mail-cipher-cache-v1:'+id);let stored;
    try {
      const encrypted=await readIndex(indexPath);
      const value=decode(encrypted,id);if(value.recipient!==recipient)fail();stored=value.blob;
      if(stored.plain.size!==blob.plain.size||stored.plain.sha256!==blob.plain.sha256)fail();
    }catch(error){if(error.code!=='ENOENT')fail();}
    if(stored) {
      await checkFile(join(root,'blobs',stored.file),stored.cipher,signal);
      const destination=join(snapshot,stored.file);
      try{await link(join(root,'blobs',stored.file),destination);}catch(error){if(error.code!=='EEXIST')throw error;await checkFile(destination,stored.cipher,signal);}
      // Only discard this run's verified, unpublished redundant ciphertext.
      if(candidate!==destination)await unlink(candidate);
      return structuredClone(stored);
    }
    await link(candidate,join(root,'blobs',blob.file));
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify({version:1,recipient,blob}),'utf8'),cipher.final()]);
    const data=Buffer.concat([magic,nonce,cipher.getAuthTag(),ciphertext]);
    const temporary=join(root,'index',randomUUID()+'.pending'),file=await open(temporary,'wx',0o600);
    try{await file.writeFile(data);await file.sync();}finally{await file.close();}
    await link(temporary,indexPath);await unlink(temporary);return blob;
  }
  return {
    adopt(blob,snapshot,signal){const task=tail.then(()=>adopt(blob,snapshot,signal));tail=task.catch(()=>{});return task;},
    collectGarbage(liveFiles,signal,assertOwner=async()=>{}){const task=tail.then(async()=>{
      if(closed||!(liveFiles instanceof Set))fail();const entries=await readdir(join(root,'index'),{withFileTypes:true}),candidates=[],known=new Set();let preserved=0;
      if(entries.length>100000)fail();
      // Authenticate and validate the entire index before the first deletion.
      for(const entry of entries) {
        signal?.throwIfAborted();if(!entry.isFile()||entry.isSymbolicLink()||! /^[a-f0-9]{64}\.idx$/.test(entry.name))fail();
        const indexPath=join(root,'index',entry.name),value=decode(await readIndex(indexPath),entry.name.slice(0,-4)),blob=value.blob;
        if(known.has(blob.file))fail();known.add(blob.file);
        const path=join(root,'blobs',blob.file);await checkFile(path,blob.cipher,signal);const stat=await lstat(path);
        if(value.recipient!==recipient||liveFiles.has(blob.file)||stat.nlink!==1){preserved++;continue;}
        candidates.push({indexPath,path,cipher:blob.cipher});
      }
      let removed=0;
      for(const item of candidates) {
        await assertOwner();
        signal?.throwIfAborted();if((await readIndex(lockPath)).toString()!==lockId)fail();
        await checkFile(item.path,item.cipher,signal);if((await lstat(item.path)).nlink!==1){preserved++;continue;}
        // Index first: an interrupted removal leaves an unindexed ciphertext,
        // never an index that silently supplies a missing object to new backups.
        await unlink(item.indexPath);await unlink(item.path);removed++;
      }
      return {removedCacheEntries:removed,preservedCacheEntries:preserved,orphanBlobsSwept:false};
    });tail=task.catch(()=>{});return task;},
    async close(){await tail;if(closed)return;closed=true;secret.fill(0);await lock.close();
      const current=await readIndex(lockPath);if(current.toString()!==lockId)fail();await unlink(lockPath);},
  };
}
