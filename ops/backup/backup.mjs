import {mkdir,writeFile,rename,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withBackupHold} from './hold-client.mjs';
import {inspectSql} from './inspect-process.mjs';
import {encryptBlob} from './age-stream.mjs';
import {writeManifest} from './manifest-io.mjs';
import {collectObjects} from './collect-objects.mjs';
import {completeGenerationReferences} from './generation-check.mjs';
import {describeRawObject} from '../../mail-worker/src/processing/queue-event.js';
import {lockCollection,releaseCollectionLock} from './collection-lock.mjs';
import {checkBackfillMetadata} from '../../mail-worker/src/processing/legacy-backfill-format.js';

async function sqlBytes(body,maxBytes,signal) {
  const chunks=[];let size=0;
  for await(const chunk of body){signal.throwIfAborted();const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)throw new Error('SQL_EXPORT_TOO_LARGE');chunks.push(bytes);}
  return Buffer.concat(chunks);
}
// The source adapter owns explicit target credentials and storage reads. Merely
// importing this module never discovers credentials or contacts Cloudflare.
export async function runBackup(options) {
  const lock=await lockCollection(options.root);
  try{return await runBackupLocked(options);}finally{await releaseCollectionLock(lock);}
}
async function runBackupLocked({source,holdClient,root,executable,recipient,schema,appCommit,appSourceSha256,legacyBackend,
  maxRunMs,maxSqlBytes=128*1024*1024,signal,cipherCache,snapshotId=randomUUID()}) {
  if(!Number.isSafeInteger(maxSqlBytes)||maxSqlBytes<1||maxSqlBytes>512*1024*1024)throw new Error('INVALID_SQL_LIMIT');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(snapshotId))throw new Error('INVALID_SNAPSHOT_ID');
  const directory=join(resolve(root),snapshotId);
  await mkdir(resolve(root),{recursive:true,mode:0o700});await mkdir(directory,{mode:0o700});
  const sealed=await withBackupHold(holdClient,async hold=>{
    await hold.assert();const snapshotAt=Date.now();
    const exported=await source.exportDatabase(hold.signal);
    const bytes=await sqlBytes(exported.body,maxSqlBytes,hold.signal);
    const inspected=await inspectSql({sql:bytes,schema,legacyBackend,signal:hold.signal});
    await hold.assert();
    const blob=await encryptBlob({executable,recipient,directory,source:[bytes],maxBytes:maxSqlBytes,signal:hold.signal});
    const references=await completeGenerationReferences(inspected.references,source.readObject.bind(source),hold.signal,hold.assert);
    const readObject=async(backend,key,signal)=>{
      const object=await source.readObject(backend,key,signal);
      if(object&&backend==='r2'&&key.startsWith('legacy/')){
        try{checkBackfillMetadata(key,object.customMetadata);}catch(error){await object.cancel?.();throw error;}
      }
      if(object&&backend==='r2'&&key.startsWith('raw/'))describeRawObject(object,{rawKey:key,deliveryId:key.split('/').at(-1).replace(/\.eml$/,'')});
      if(object&&backend==='r2'&&/^(derived|inline|attachments)\/[^/]+\/[a-f0-9]{64}\//.test(key)) {
        const [,deliveryId,generation]=key.split('/');
        if(object.customMetadata?.deliveryId!==deliveryId||object.customMetadata?.generation!==generation)throw new Error('BACKUP_OBJECT_METADATA_MISMATCH');
      }
      return object;
    };
    const objects=await collectObjects({references,inventory:source.inventory(snapshotAt,hold.signal),
      readObject,snapshotAt,assertHold:hold.assert,signal:hold.signal,executable,recipient,directory,cipherCache});
    const manifest={version:1,encryption:'age-v1',snapshotId,snapshotAt,createdAt:Date.now(),appCommit,appSourceSha256,schema,
      database:{bookmark:exported.bookmark,blob},objects,deletionLedgerThrough:snapshotAt};
    const manifestBlob=await writeManifest({manifest,executable,recipient,directory,signal:hold.signal});
    return {manifestBlob,snapshotId,owner:hold.owner,snapshotAt};
  },{maxRunMs,signal});
  // All source reads and integrity checks finished while the hold was verified.
  // Publish only after withBackupHold's final assertion succeeds. No source data
  // is read after release; a failed/expired hold leaves an uncommitted directory.
  const temporary=join(directory,'complete.pending');
  await writeFile(temporary,JSON.stringify({version:1,snapshotId:sealed.snapshotId,manifestBlob:sealed.manifestBlob}),{flag:'wx',mode:0o600});
  const file=await open(temporary,'r+');try{await file.sync();}finally{await file.close();}
  await rename(temporary,join(directory,'complete.json'));
  let receipt='NOT_CONFIGURED';
  if(holdClient.complete)try{await holdClient.complete(sealed.owner,{snapshotId,snapshotAt:sealed.snapshotAt,manifestHash:sealed.manifestBlob.cipher.sha256},AbortSignal.timeout(10000));receipt='RECORDED';}catch{receipt='PENDING';}
  return {snapshotId,directory,receipt};
}
