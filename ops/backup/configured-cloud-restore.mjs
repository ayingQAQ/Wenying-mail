import {open,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {d1RestoreDatabase} from './d1-restore-target.mjs';
import {r2RestoreObjects} from './r2-restore-target.mjs';
import {kvRestoreObjects} from './kv-restore-target.mjs';
import {s3RestoreObjects} from './s3-restore-target.mjs';
import {cloudRestoreTarget} from './cloud-restore-target.mjs';
import {restoreBackup} from './restore.mjs';

// A run directory is never reused. The fsynced journal is authoritative; a
// failed/ambiguous cloud write retains its resources for operator inspection.
export async function configuredCloudRestore({config,credentials,runDirectory,fetcher,r2RequestHandler,s3RequestHandler,...options}) {
  const directory=resolve(runDirectory),deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(),config.maxRunMs);
  const signal=options.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal;
  let journal,target;const opened=[];let complete=false;
  try {
    signal.throwIfAborted();await mkdir(directory,{recursive:false,mode:0o700});
    journal=await open(join(directory,'restore-journal.jsonl'),'wx',0o600);
    async function record(event){await journal.writeFile(JSON.stringify({at:Date.now(),...event})+'\n');await journal.sync();}
    await record({phase:'RUN_PREPARED',snapshotId:config.snapshotId,accountId:config.accountId,environment:config.environment,
      configSha256:createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      databaseId:config.d1.databaseId,databaseName:config.d1.databaseName,bucket:config.r2.bucket,
      ...(config.s3?{s3:{endpoint:config.s3.endpoint,bucket:config.s3.bucket}}:{})});
    const database=d1RestoreDatabase({...config.d1,accountId:config.accountId,token:credentials.apiToken,
      schema:options.schema,legacyBackend:options.legacyBackend,signal,fetcher});opened.push(database);
    const r2=r2RestoreObjects({...config.r2,accountId:config.accountId,apiToken:credentials.apiToken,
      accessKeyId:credentials.r2AccessKeyId,secretAccessKey:credentials.r2SecretAccessKey,fetcher,requestHandler:r2RequestHandler});opened.push(r2);
    const kv=config.kv?kvRestoreObjects({...config.kv,accountId:config.accountId,token:credentials.apiToken,environment:config.environment,signal,record,fetcher}):undefined;if(kv)opened.push(kv);
    const s3=config.s3?s3RestoreObjects({target:config.s3,accessKeyId:credentials.s3AccessKeyId,secretAccessKey:credentials.s3SecretAccessKey,requestHandler:s3RequestHandler}):undefined;if(s3)opened.push(s3);
    target=cloudRestoreTarget({database,r2,kv,s3,signal,record});
    const result=await restoreBackup({...options,signal,target,expectedSnapshotId:config.snapshotId});
    // restoreBackup closes every adapter before this durable terminal record.
    await record({phase:'RUN_COMPLETE',report:result});complete=true;return result;
  } catch {
    if(journal)try{await journal.writeFile(JSON.stringify({at:Date.now(),phase:'RUN_FAILED',error:signal.aborted?'OPERATION_ABORTED':'CLOUD_RESTORE_FAILED'})+'\n');await journal.sync();}catch{}
    throw Error(signal.aborted?'OPERATION_ABORTED':'CLOUD_RESTORE_FAILED');
  } finally {
    clearTimeout(timer);
    // Covers constructor failures before a composite target exists, too.
    try{if(!complete){if(target)await target.close();else await Promise.allSettled(opened.map(value=>Promise.resolve().then(()=>value.close())));}}
    finally{await journal?.close();}
  }
}
