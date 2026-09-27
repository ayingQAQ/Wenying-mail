import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,unlink,open} from 'node:fs/promises';
import {Transform,Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';

function meter(limit) {
  if(!Number.isSafeInteger(limit) || limit<0) throw new Error('INVALID_BACKUP_LIMIT');
  const hash=createHash('sha256');let size=0;
  const stream=new Transform({transform(chunk,encoding,callback){
    size+=chunk.length;if(size>limit)return callback(new Error('BACKUP_SIZE_LIMIT'));
    hash.update(chunk);callback(null,chunk);
  }});
  return {stream,result:()=>({size,sha256:hash.digest('hex')})};
}

async function runAge(executable,args,input,output,signal) {
  if(signal?.aborted) {input.destroy(new Error('BACKUP_ABORTED'));output.destroy(new Error('BACKUP_ABORTED'));throw new Error('BACKUP_ABORTED');}
  const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  // Diagnostics can contain paths and identities. Expose only fixed error codes.
  child.stderr.resume();
  const exited=new Promise((resolve,reject)=>{
    child.once('error',()=>reject(new Error('AGE_PROCESS_FAILED')));
    child.once('close',code=>code===0?resolve():reject(new Error('AGE_PROCESS_FAILED')));
  });
  const abort=()=>{child.kill();input.destroy(new Error('BACKUP_ABORTED'));output.destroy(new Error('BACKUP_ABORTED'));};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const tasks=[exited,pipeline(input,child.stdin),pipeline(child.stdout,output)];
    const results=await Promise.allSettled(tasks.map(task=>task.catch(error=>{child.kill();throw error;})));
    if(results.some(result=>result.status==='rejected')) throw new Error(signal?.aborted?'BACKUP_ABORTED':'AGE_STREAM_FAILED');
  } finally {signal?.removeEventListener('abort',abort);}
}

export async function encryptBlob({executable,recipient,directory,source,maxBytes,signal}) {
  if(typeof recipient!=='string' || !/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('INVALID_AGE_RECIPIENT');
  const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});
  const file=`${randomUUID()}.age`,path=join(root,file);
  const plain=meter(maxBytes),cipher=meter(maxBytes+Math.ceil(maxBytes/65536)*32+65536);
  const input=Readable.from(source),output=createWriteStream(path,{flags:'wx',mode:0o600});
  // Link all streams with pipeline so read failures abort age and never leave
  // an apparently complete artifact. Plaintext travels only through memory.
  const feed=pipeline(input,plain.stream).catch(error=>{plain.stream.destroy(error);throw error;});
  const drain=pipeline(cipher.stream,output).catch(error=>{cipher.stream.destroy(error);throw error;});
  const result=await Promise.allSettled([feed,drain,runAge(executable,['--encrypt','--recipient',recipient],plain.stream,cipher.stream,signal)]);
  if(result.some(item=>item.status==='rejected')) {await unlink(path).catch(()=>{});throw new Error('BACKUP_ENCRYPTION_FAILED');}
  try {const file=await open(path,'r+');try{await file.sync();}finally{await file.close();}}
  catch {await unlink(path).catch(()=>{});throw new Error('BACKUP_ENCRYPTION_FAILED');}
  return {file,plain:plain.result(),cipher:cipher.result()};
}

export async function decryptBlob({executable,identityFile,directory,blob,destination,signal}) {
  if(!/^[a-f0-9-]{36}\.age$/.test(blob.file) || !/^[a-f0-9]{64}$/.test(blob.cipher?.sha256) || !/^[a-f0-9]{64}$/.test(blob.plain?.sha256))
    throw new Error('INVALID_BACKUP_BLOB');
  const path=join(resolve(directory),blob.file);
  // Verify ciphertext first, before exposing any decrypted bytes to a restore sink.
  const cipher=meter(blob.cipher.size);
  await pipeline(createReadStream(path),cipher.stream,new Writable({write(chunk,encoding,callback){callback();}}));
  if(JSON.stringify(cipher.result())!==JSON.stringify({size:blob.cipher.size,sha256:blob.cipher.sha256})) throw new Error('BACKUP_CIPHERTEXT_MISMATCH');
  const plain=meter(blob.plain.size);
  const drain=pipeline(plain.stream,destination);
  const result=await Promise.allSettled([drain,runAge(executable,['--decrypt','--identity',identityFile],createReadStream(path),plain.stream,signal)]);
  if(result.some(item=>item.status==='rejected')) throw new Error('BACKUP_DECRYPTION_FAILED');
  const actual=plain.result();
  if(actual.size!==blob.plain.size || actual.sha256!==blob.plain.sha256) throw new Error('BACKUP_PLAINTEXT_MISMATCH');
  return actual;
}
