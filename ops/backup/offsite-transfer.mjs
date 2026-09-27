import {open,mkdir,readdir,lstat,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateBlob} from './manifest.mjs';
import {lockCollection,releaseCollectionLock} from './collection-lock.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new Error('OFFSITE_TRANSFER_FAILED');};
const MAX_FILE=600*1024*1024,MAX_CATALOG=16*1024*1024,MAX_TOTAL=12*1024*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function marker(value){
  if(!value||Object.keys(value).sort().join(',')!=='manifestBlob,snapshotId,version'||value.version!==1||!uuid.test(value.snapshotId))fail();
  validateBlob(value.manifestBlob);return value;
}
async function consume(body,{size,sha256},signal,sink) {
  let count=0;const hash=createHash('sha256');
  for await(const chunk of body){signal.throwIfAborted();const bytes=Buffer.from(chunk);count+=bytes.length;if(count>size)fail();hash.update(bytes);await sink?.(bytes);}
  const actual=hash.digest('hex');if(count!==size||sha256&&actual!==sha256)fail();return actual;
}
async function localBytes(path,limit) {
  const file=await open(path,'r');try{const buffer=Buffer.alloc(limit+1);let count=0;
    while(count<buffer.length){const result=await file.read(buffer,count,buffer.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
    if(count>limit)fail();return buffer.subarray(0,count);
  }finally{await file.close();}
}
function catalog(value) {
  if(!value||Object.keys(value).sort().join(',')!=='files,marker,version'||value.version!==1||!Array.isArray(value.files)||!value.files.length||value.files.length>100000)fail();
  marker(value.marker);const seen=new Set();let total=0;
  for(const file of value.files){if(!file||Object.keys(file).sort().join(',')!=='file,sha256,size'||typeof file.file!=='string'||!file.file.endsWith('.age')||!uuid.test(file.file.slice(0,-4))||seen.has(file.file)||
    !Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE||! /^[a-f0-9]{64}$/.test(file.sha256))fail();seen.add(file.file);total+=file.size;if(total>MAX_TOTAL)fail();}
  const manifest=value.files.find(file=>file.file===value.marker.manifestBlob.file);
  if(!manifest||manifest.size!==value.marker.manifestBlob.cipher.size||manifest.sha256!==value.marker.manifestBlob.cipher.sha256)fail();return value;
}
async function matches(store,key,description,signal) {
  const object=await store.get(key,signal);if(!object)return false;
  try{if(object.size!==description.size)fail();await consume(object.body,description,signal);return true;}finally{object.cancel();}
}
async function publish(store,key,description,body,signal) {
  if(await matches(store,key,description,signal))return;
  await store.put(key,{...description,body:body()},signal);
  if(!await matches(store,key,description,signal))fail();
}

// Transport integrity only. This public-key runner does not decrypt archives;
// downloaded snapshots still require verifyBackup and application acceptance.
export async function uploadSnapshot(options) {
  const lock=await lockCollection(dirname(resolve(options.directory)));
  try{return await uploadLocked(options);}finally{await releaseCollectionLock(lock);}
}
async function uploadLocked({directory,store,signal}) {
  directory=resolve(directory);signal.throwIfAborted();
  const root=await lstat(directory);if(!root.isDirectory()||root.isSymbolicLink())fail();
  const complete=marker(JSON.parse((await localBytes(join(directory,'complete.json'),65536)).toString('utf8'))),files=[];
  const entries=await readdir(directory,{withFileTypes:true});if(entries.length>100001)fail();
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!entry.isFile()||entry.isSymbolicLink())fail();if(entry.name==='complete.json')continue;
    if(!entry.name.endsWith('.age')||!uuid.test(entry.name.slice(0,-4)))fail();
    const path=join(directory,entry.name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE)fail();
    const file={file:entry.name,size:stat.size,sha256:await consume(createReadStream(path),{size:stat.size},signal)};files.push(file);
  }
  const plan=catalog({version:1,marker:complete,files}),bytes=Buffer.from(JSON.stringify(plan));if(bytes.length>MAX_CATALOG)fail();
  await store.begin(signal);
  return store.withWriteLock(async lock=>{
    for(const file of files)await publish(store,'blobs/'+file.file,file,()=>createReadStream(join(directory,file.file)),signal);
    lock.publicationStarted();
    await publish(store,`snapshots/${complete.snapshotId}/transport.json`,{size:bytes.length,sha256:digest(bytes)},()=>bytes,signal);
    lock.publicationVerified();
    return {snapshotId:complete.snapshotId,transportVerified:true,files:files.length,catalogSha256:digest(bytes),requiresDecryptionVerification:true};
  },signal);
}

export async function downloadSnapshot({snapshotId,directory,store,signal}) {
  if(!uuid.test(snapshotId))fail();signal.throwIfAborted();await store.begin(signal);
  const object=await store.get(`snapshots/${snapshotId}/transport.json`,signal);if(!object)fail();let plan;
  try{if(object.size>MAX_CATALOG)fail();const chunks=[];await consume(object.body,{size:object.size},signal,bytes=>{chunks.push(bytes);});plan=catalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
  finally{object.cancel();}
  if(plan.marker.snapshotId!==snapshotId)fail();directory=resolve(directory);await mkdir(directory,{mode:0o700});
  for(const entry of plan.files) {
    const object=await store.get('blobs/'+entry.file,signal);if(!object)fail();let file;
    try{if(object.size!==entry.size)fail();file=await open(join(directory,entry.file),'wx',0o600);
      await consume(object.body,entry,signal,async bytes=>{await file.writeFile(bytes);});await file.sync();
    }finally{object.cancel();await file?.close();}
  }
  const path=join(directory,'complete.pending'),file=await open(path,'wx',0o600);
  try{await file.writeFile(JSON.stringify(plan.marker));await file.sync();}finally{await file.close();}
  signal.throwIfAborted();await rename(path,join(directory,'complete.json'));
  return {snapshotId,transportVerified:true,requiresDecryptionVerification:true};
}
