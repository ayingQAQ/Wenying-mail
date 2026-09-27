import {mkdir,open,lstat,rename,unlink,readdir} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {configuredBackup} from './configured-backup.mjs';
import {offsiteS3} from './offsite-s3.mjs';
import {uploadSnapshot} from './offsite-transfer.mjs';
import {backupHoldClient} from './hold-client.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fail=()=>{throw new Error('BACKUP_JOB_STATE_INVALID');};
async function json(path) {
  const file=await open(path,'r');try{const bytes=Buffer.alloc(65537);let size=0;
    while(size<bytes.length){const result=await file.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>65536)fail();return JSON.parse(bytes.subarray(0,size).toString('utf8'));
  }finally{await file.close();}
}
export async function runBackupJob({directory,backup,offsite,schema,signal,backupDependencies={},offsiteDependencies={}}) {
  directory=resolve(directory);signal.throwIfAborted();
  if(backup.config.environment!==offsite.config.environment)fail();
  const normalize=path=>(process.platform==='win32'?resolve(path).toLowerCase():resolve(path))+sep;
  for(const other of [backup.config.destination,backup.config.cipherCache?.directory].filter(Boolean)) {
    if(normalize(directory).startsWith(normalize(other))||normalize(other).startsWith(normalize(directory)))fail();
  }
  const configHash=createHash('sha256').update(JSON.stringify(canonical({backup:backup.config,offsite:offsite.config}))).digest('hex');
  try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const root=await lstat(directory);if(!root.isDirectory()||root.isSymbolicLink())fail();
  const lockPath=join(directory,'.run-lock'),lock=await open(lockPath,'wx',0o600),owner=randomUUID();
  await lock.writeFile(owner);await lock.sync();let state;
  async function save() {
    const path=join(directory,randomUUID()+'.pending'),file=await open(path,'wx',0o600);
    try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
    await rename(path,join(directory,'state.json'));
  }
  try {
    try{state=await json(join(directory,'state.json'));}catch(error){if(error.code!=='ENOENT')throw error;
      if((await readdir(directory)).some(name=>name!=='.run-lock'))fail();
      state={version:1,configHash,snapshotId:randomUUID(),phase:'NEW',receipt:'PENDING',offsiteReceipt:'PENDING',catalogSha256:null};await save();
    }
    if(state&&!Object.hasOwn(state,'offsiteReceipt'))state.offsiteReceipt='PENDING';
    if(!state||Object.keys(state).sort().join(',')!=='catalogSha256,configHash,offsiteReceipt,phase,receipt,snapshotId,version'||state.version!==1||state.configHash!==configHash||
      !uuid.test(state.snapshotId)||!['NEW','BACKUP_STARTED','SNAPSHOT_READY','COMPLETE'].includes(state.phase)||
      !['PENDING','RECORDED'].includes(state.receipt)||!['PENDING','RECORDED'].includes(state.offsiteReceipt)||(state.catalogSha256!==null&&!/^[a-f0-9]{64}$/.test(state.catalogSha256)))fail();
    if(state.phase==='NEW') {
      state.phase='BACKUP_STARTED';await save();
      const result=await configuredBackup({...backup,schema,signal,snapshotId:state.snapshotId,fetcher:backupDependencies.fetcher,
        r2RequestHandler:backupDependencies.r2RequestHandler,s3RequestHandler:backupDependencies.s3RequestHandler});
      state.receipt=result.receipt==='RECORDED'?'RECORDED':'PENDING';state.phase='SNAPSHOT_READY';await save();
    }
    const snapshot=join(backup.config.destination,state.snapshotId);
    if(state.phase==='BACKUP_STARTED') {
      // Never repeat an uncertain database export. Resume only a published local
      // snapshot at the pre-recorded UUID; incomplete candidates stay untouched.
      const marker=await json(join(snapshot,'complete.json'));if(marker.snapshotId!==state.snapshotId)fail();
      state.phase='SNAPSHOT_READY';await save();
    }
    const marker=await json(join(snapshot,'complete.json'));if(marker.snapshotId!==state.snapshotId)fail();
    const reporter=backupHoldClient({origin:backup.config.holdOrigin,clientId:backup.credentials.accessClientId,clientSecret:backup.credentials.accessClientSecret,fetcher:backupDependencies.fetcher});
    const reportIdentity={attemptId:randomUUID(),snapshotId:state.snapshotId,manifestHash:marker.manifestBlob?.cipher?.sha256,
      targetHash:createHash('sha256').update(JSON.stringify(canonical(offsite.config.target))).digest('hex')};
    let reporting=false;
    try{await reporter.offsite({...reportIdentity,phase:'PENDING'},AbortSignal.timeout(10000));reporting=true;}catch{}
    state.offsiteReceipt='PENDING';
    const transferSignal=AbortSignal.any([signal,AbortSignal.timeout(offsite.config.maxRunMs)]);
    const store=offsiteS3({target:offsite.config.target,...offsite.credentials,requestHandler:offsiteDependencies.requestHandler});
    try {
      // Even completed jobs revalidate remote ciphertext on an explicit rerun.
      const result=await uploadSnapshot({directory:snapshot,store,signal:transferSignal});
      if(reporting)try{await reporter.offsite({...reportIdentity,phase:'COMPLETE',catalogHash:result.catalogSha256},AbortSignal.timeout(10000));state.offsiteReceipt='RECORDED';}catch{}
      state.catalogSha256=result.catalogSha256;state.phase='COMPLETE';await save();
    }catch(error){if(reporting)await reporter.offsite({...reportIdentity,phase:'FAILED'},AbortSignal.timeout(10000)).catch(()=>{});throw error;}
    finally{store.close();}
    return {snapshotId:state.snapshotId,localSnapshotComplete:true,offsiteTransportVerified:true,receipt:state.receipt,offsiteReceipt:state.offsiteReceipt,requiresRestoreAcceptance:true};
  }finally {
    await lock.close();const handle=await open(lockPath,'r');let actual;
    try{const bytes=Buffer.alloc(37),result=await handle.read(bytes,0,37,0);actual=bytes.subarray(0,result.bytesRead).toString();}finally{await handle.close();}
    if(actual!==owner)fail();await unlink(lockPath);
  }
}
