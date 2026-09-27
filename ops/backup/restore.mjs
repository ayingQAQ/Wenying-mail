import {open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Writable} from 'node:stream';
import {readManifest} from './manifest-io.mjs';
import {decryptBlob} from './age-stream.mjs';
import {inspectSql} from './inspect-process.mjs';
import {completeGenerationReferences} from './generation-check.mjs';
import {describeRawObject} from '../../mail-worker/src/processing/queue-event.js';
import {checkBackfillMetadata} from '../../mail-worker/src/processing/legacy-backfill-format.js';

const id=(backend,key)=>JSON.stringify([backend,key]);
async function markerFile(path) {
  const file=await open(path,'r');try {
    if((await file.stat()).size>65536)throw new Error('INVALID_COMPLETE_MARKER');
    const marker=JSON.parse(await file.readFile('utf8'));
    if(marker.version!==1||typeof marker.snapshotId!=='string'||Object.keys(marker).some(key=>!['version','snapshotId','manifestBlob'].includes(key)))throw new Error('INVALID_COMPLETE_MARKER');
    return marker;
  } finally {await file.close();}
}
async function bytes(options,blob,limit) {
  if(blob.plain.size>limit)throw new Error('RESTORE_BLOB_TOO_LARGE');
  const chunks=[];await decryptBlob({...options,blob,destination:new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}})});
  return Buffer.concat(chunks);
}
export async function verifyBackup({directory,executable,identityFile,schema,legacyBackend,signal}) {
  directory=resolve(directory);const marker=await markerFile(join(directory,'complete.json'));
  const options={directory,executable,identityFile,signal};
  const manifest=await readManifest({...options,blob:marker.manifestBlob});
  if(marker.snapshotId!==manifest.snapshotId||JSON.stringify(manifest.schema)!==JSON.stringify(schema))throw new Error('BACKUP_IDENTITY_MISMATCH');
  const sql=await bytes(options,manifest.database.blob,512*1024*1024);
  const inspected=await inspectSql({sql,schema,legacyBackend,signal});
  const objects=new Map(manifest.objects.map(object=>[id(object.backend,object.key),object]));
  for(const object of manifest.objects) {
    signal?.throwIfAborted();
    await decryptBlob({...options,blob:object.blob,destination:new Writable({write(chunk,encoding,done){done();}})});
    if(object.backend==='r2'&&object.key.startsWith('legacy/'))checkBackfillMetadata(object.key,object.customMetadata);
    if(object.backend==='r2'&&object.key.startsWith('raw/'))describeRawObject({...object,size:object.blob.plain.size},{rawKey:object.key,deliveryId:object.key.split('/').at(-1).replace(/\.eml$/,'')});
    if(object.backend==='r2'&&/^(derived|inline|attachments)\/[^/]+\/[a-f0-9]{64}\//.test(object.key)) {
      const [,deliveryId,generation]=object.key.split('/');
      if(object.customMetadata.deliveryId!==deliveryId||object.customMetadata.generation!==generation)throw new Error('BACKUP_OBJECT_METADATA_MISMATCH');
    }
  }
  const references=await completeGenerationReferences(inspected.references,async(backend,key)=>{
    const object=objects.get(id(backend,key));if(!object)return null;
    return {...object,size:object.blob.plain.size,body:[await bytes(options,object.blob,1024*1024)]};
  },signal??new AbortController().signal,async()=>{});
  for(const ref of references) {
    const object=objects.get(id(ref.backend,ref.key));
    if(!object||ref.size!==null&&ref.size!==object.blob.plain.size||ref.sha256!==null&&ref.sha256!==object.blob.plain.sha256)throw new Error('BACKUP_REFERENCE_MISMATCH');
  }
  const ledger=[...inspected.ledger];
  for(const object of manifest.objects.filter(item=>item.backend==='r2'&&item.key.startsWith('tombstones/'))) {
    let item;try{item=JSON.parse((await bytes(options,object.blob,512)).toString('utf8'));}catch{throw new Error('INVALID_BACKUP_TOMBSTONE');}
    if(item.version!==1||object.key!==`tombstones/${item.deliveryId}.json`)throw new Error('INVALID_BACKUP_TOMBSTONE');
    ledger.push({deliveryId:item.deliveryId,deletedAt:item.deletedAt,reasonCode:item.reasonCode});
  }
  const unique=new Map(),now=Date.now();
  for(const item of ledger) {
    if(!/^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|legacy-email-[1-9][0-9]*)$/.test(item.deliveryId)||
      !Number.isSafeInteger(item.deletedAt)||item.deletedAt<0||item.deletedAt>now||
      !['USER_DELETE','TRASH_EXPIRED','IDENTITY_RETIRED'].includes(item.reasonCode))throw new Error('INVALID_BACKUP_TOMBSTONE');
    const old=unique.get(item.deliveryId);
    if(old&&(old.deletedAt!==item.deletedAt||old.reasonCode!==item.reasonCode))throw new Error('CONFLICTING_DELETION_LEDGER');
    unique.set(item.deliveryId,item);
  }
  return {manifest,manifestBlob:marker.manifestBlob,sql,ledger:[...unique.values()],options};
}

export async function restoreBackup({target,latestLedger=[],ledgerThrough,expectedSnapshotId,...options}) {
  const startedAt=Date.now();
  try {
  // Verify every archived byte before creating or writing a restore target.
  const verified=await verifyBackup(options),{manifest,sql}=verified;
  if(expectedSnapshotId!==undefined&&manifest.snapshotId!==expectedSnapshotId)throw new Error('RESTORE_SNAPSHOT_MISMATCH');
  if(target.supportedBackends&&manifest.objects.some(object=>!target.supportedBackends.includes(object.backend)))throw new Error('RESTORE_BACKEND_UNSUPPORTED');
  const cutoff=ledgerThrough??manifest.deletionLedgerThrough;
  if(cutoff<manifest.deletionLedgerThrough)throw new Error('STALE_DELETION_LEDGER');
  const prepared=await inspectSql({sql,schema:options.schema,legacyBackend:options.legacyBackend,signal:options.signal,
    action:'restore',latestLedger:[...verified.ledger,...latestLedger],ledgerThrough:cutoff});
  const deleted=new Set(prepared.ledger.map(item=>item.deliveryId));
  const retained=new Set(prepared.references.map(item=>id(item.backend,item.key)));
  await target.begin();
    // Tombstones always precede original content and database activation.
    for(const item of prepared.ledger) {
      const data=Buffer.from(JSON.stringify({version:1,...item}));
      await target.putObject({backend:'r2',key:`tombstones/${item.deliveryId}.json`,customMetadata:{},httpMetadata:{contentType:'application/json'}},data);
    }
    for(const object of manifest.objects) {
      options.signal?.throwIfAborted();
      if(object.key.startsWith('tombstones/')&&object.backend==='r2')continue;
      // Backfilled legacy copies have a numeric email namespace, while their
      // deletion identity is legacy-email-<id>. Only replay retained references;
      // raw inventory recovery rules must not restore deleted legacy copies.
      if(object.backend==='r2'&&object.key.startsWith('legacy/')&&!retained.has(id(object.backend,object.key)))continue;
      const delivery=object.key.startsWith('raw/')?object.key.split('/').at(-1).replace(/\.eml$/,''):object.key.split('/')[1];
      if(object.backend==='r2'&&deleted.has(delivery))continue;
      if(/^attachments\/[^/]+$/.test(object.key)&&!retained.has(id(object.backend,object.key)))continue;
      const data=await bytes(verified.options,object.blob,25*1024*1024);
      await target.putObject(object,data);
    }
    await target.importDatabase(prepared.preparedSql,{signal:options.signal});
    // Target must independently verify stored bytes/metadata and DB state here.
    await target.verify(prepared.contract,{signal:options.signal});
    options.signal?.throwIfAborted();
    const completedAt=Date.now();
    const report={snapshotId:manifest.snapshotId,snapshotAt:manifest.snapshotAt,ledgerThrough:cutoff,
      startedAt,completedAt,elapsedMs:completedAt-startedAt,
      snapshotAgeMs:Math.max(0,startedAt-manifest.snapshotAt),
      deletionUncertainty:{from:cutoff,to:completedAt},
      receivingEnabled:false,sessionsRestored:false,requiresAcceptance:true};
    return await target.finish(report)??report;
  } finally {await target.close();}
}
