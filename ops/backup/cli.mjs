import {readFile,open,readdir,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyBackup,restoreBackup} from './restore.mjs';
import {readBackupConfig} from './backup-config.mjs';
import {readOffsiteConfig} from './offsite-config.mjs';
import {readS3RestoreConfig} from './s3-restore-config.mjs';
import {readCloudRestoreConfig} from './cloud-restore-config.mjs';

export const help=`Usage: node ops/backup/cli.mjs <command> [options]
Commands:
  check-config   Validate local backup config; no network or directory creation
  backup         Run encrypted D1/R2 backup under service hold
  backup-offsite Run/resume one recorded backup plus offsite upload job
  check-offsite-config Validate local offsite config without network access
  upload-offsite Upload a complete encrypted snapshot; publish remote marker last
  download-offsite Download encrypted snapshot into a NEW local directory
  verify         Verify all encrypted snapshot content; no target writes
  plan-retention Verify a snapshot collection and report retention candidates; no deletion
  plan-offsite-retention Download/verify remote snapshots into a NEW local collection; no remote writes
  prune-offsite Revalidate approved hashes under remote lock; prune only expired snapshot references
  prune-local    Revalidate an approved catalog and remove only retired local snapshots
  prune-cache    Revalidate all local snapshots and reclaim unreferenced cache entries
  export-ledger  Verify snapshot, write minimal deletion ledger to a new file
  collect-ledger Supplement verified snapshot ledger from configured R2 tombstones
  restore-local  Restore into a NEW local Miniflare directory with receiving disabled
  check-s3-restore-config Validate a plaintext S3 restore target configuration offline
  restore-mixed Restore D1/R2/KV locally and plaintext legacy attachments into explicit S3
  check-cloud-restore-config Validate isolated cloud restore configuration offline
  restore-cloud Restore into exclusive empty D1/R2 resources and a NEW KV namespace
backup/check-config require only: --config FILE
backup-offsite requires: --config FILE --offsite-config FILE --run-directory JOB_DIRECTORY
check-offsite-config requires: --config FILE
upload-offsite requires: --config FILE --snapshot DIR
download-offsite requires: --config FILE --snapshot-id UUID --target NEW_DIRECTORY
verify/plan-retention/export-ledger/restore-local require: --snapshot DIR --identity FILE --age EXECUTABLE
plan-retention uses --snapshot for the collection directory (UUID subdirectories)
plan-offsite-retention also requires --config OFFSITE_CONFIG; --snapshot must be a NEW local collection
prune-offsite additionally requires --catalog-sha256 HASH --inventory-sha256 HASH --run-directory NEW_JOURNAL_DIRECTORY
Options: --legacy-backend r2|kv|s3 --schema-version N --timeout-ms N
prune-local requires the same verification options plus --catalog-sha256 HASH
prune-cache requires the same verification and catalog options plus --config BACKUP_CONFIG (no cloud credentials)
export-ledger requires: --output FILE
collect-ledger requires the same verification options plus --config FILE --output NEW_FILE; reads R2 only
restore-local requires: --target NEW_DIRECTORY
restore-local optional: --ledger FILE
restore-mixed requires restore-local options plus --s3-config FILE
check-s3-restore-config requires only: --config FILE
check-cloud-restore-config requires only: --config FILE
restore-cloud requires verification options plus --config FILE --run-directory NEW_DIRECTORY; optional --ledger FILE
Private keys and credentials must never be passed as argument values.
No command deploys, enables receiving or schedules jobs. prune-local/prune-cache delete their selected local data; prune-offsite deletes approved remote data.
backup reads configured cloud resources and writes only a local encrypted snapshot plus the service hold/receipt.
restore-mixed writes decrypted attachments to the configured existing private empty S3 bucket.
restore-cloud writes decrypted data to configured cloud targets and retains all candidates on failure.\n`;

function parse(argv) {
  if(argv.length===1&&['--help','help'].includes(argv[0]))return {command:'help'};
  const [command,...rest]=argv;
  if(['backup-offsite','check-offsite-config','upload-offsite','download-offsite'].includes(command)) {
    const keys=command==='backup-offsite'?['config','offsite-config','run-directory']:command==='check-offsite-config'?['config']:command==='upload-offsite'?['config','snapshot']:['config','snapshot-id','target'],values={};
    for(let index=0;index<rest.length;index+=2) {
      const key=rest[index].replace(/^--/,''),value=rest[index+1];
      if(!rest[index].startsWith('--')||!keys.includes(key)||Object.hasOwn(values,key)||!value||value.startsWith('--'))throw new Error('INVALID_ARGUMENTS');
      values[key]=value;
    }
    if(keys.some(key=>!values[key])||(values['snapshot-id']&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['snapshot-id'])))throw new Error('INVALID_ARGUMENTS');
    return {command,values};
  }
  if(['backup','check-config','check-s3-restore-config','check-cloud-restore-config'].includes(command)) {
    if(rest.length!==2||rest[0]!=='--config'||!rest[1]||rest[1].startsWith('--'))throw new Error('INVALID_ARGUMENTS');
    return {command,values:{config:rest[1]},timeout:14400000};
  }
  const extras={verify:[], 'plan-retention':[], 'plan-offsite-retention':['config'], 'prune-offsite':['config','catalog-sha256','inventory-sha256','run-directory'], 'prune-local':['catalog-sha256'],'prune-cache':['config','catalog-sha256'], 'export-ledger':['output'],'collect-ledger':['config','output'],'restore-local':['target','ledger'],'restore-mixed':['target','ledger','s3-config'],'restore-cloud':['config','run-directory','ledger']}[command];
  if(!extras)throw new Error('INVALID_ARGUMENTS');
  const allowed=new Set(['snapshot','identity','age','legacy-backend','schema-version','timeout-ms',...extras]),values={};
  for(let index=0;index<rest.length;index+=2) {
    const key=rest[index].replace(/^--/,''),value=rest[index+1];
    if(!rest[index].startsWith('--')||!allowed.has(key)||Object.hasOwn(values,key)||!value||value.startsWith('--'))throw new Error('INVALID_ARGUMENTS');
    values[key]=value;
  }
  if(['snapshot','identity','age',...(command==='restore-cloud'?['config','run-directory']:command==='restore-mixed'?['target','s3-config']:command==='restore-local'?['target']:command==='collect-ledger'?['config','output']:command==='export-ledger'?['output']:[])].some(key=>!values[key]))throw new Error('INVALID_ARGUMENTS');
  if(values['legacy-backend']&&!['r2','kv','s3'].includes(values['legacy-backend']))throw new Error('INVALID_ARGUMENTS');
  if(['prune-local','prune-cache','prune-offsite'].includes(command)&&!/^[a-f0-9]{64}$/.test(values['catalog-sha256']??''))throw new Error('INVALID_ARGUMENTS');
  if(['prune-cache','plan-offsite-retention','prune-offsite'].includes(command)&&!values.config)throw new Error('INVALID_ARGUMENTS');
  if(command==='prune-offsite'&&(!values['run-directory']||!/^[a-f0-9]{64}$/.test(values['inventory-sha256']??'')))throw new Error('INVALID_ARGUMENTS');
  for(const key of ['schema-version','timeout-ms'])if(values[key]&&!/^[1-9][0-9]*$/.test(values[key]))throw new Error('INVALID_ARGUMENTS');
  const timeout=Number(values['timeout-ms']??14400000);
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>86400000)throw new Error('INVALID_ARGUMENTS');
  return {command,values,timeout};
}

async function schemaVersions(version) {
  const root=new URL('../../mail-worker/migrations/',import.meta.url);
  const names=(await readdir(root)).filter(name=>name.endsWith('.sql')).sort(),count=Number(version??names.length);
  if(!Number.isSafeInteger(count)||count<1||count>names.length)throw new Error('INVALID_ARGUMENTS');
  return Promise.all(names.slice(0,count).map(async version=>({version,
    checksum:createHash('sha256').update((await readFile(new URL(version,root),'utf8')).replaceAll('\r\n','\n')).digest('hex')})));
}

async function ledgerFile(path) {
  const file=await open(path,'r');
  try {
    const chunks=[];let size=0;
    for await(const chunk of file.createReadStream({autoClose:false})){size+=chunk.length;if(size>32*1024*1024)throw new Error();chunks.push(chunk);}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!data||Object.keys(data).sort().join(',')!=='entries,ledgerThrough,version'||data.version!==1||
      !Number.isSafeInteger(data.ledgerThrough)||data.ledgerThrough<0||data.ledgerThrough>Date.now()||!Array.isArray(data.entries))throw new Error();
    for(const item of data.entries)if(!item||Object.keys(item).sort().join(',')!=='deletedAt,deliveryId,reasonCode')throw new Error();
    return data;
  } finally {await file.close();}
}

// Keep stdout machine-readable. Never emit raw vendor, filesystem or age errors.
export async function runCli(argv,{stdout=process.stdout,stderr=process.stderr,signal,environment=process.env,backupDependencies={},offsiteDependencies={},restoreDependencies={}}={}) {
  let timer,operationSignal=signal,phase='INVALID_ARGUMENTS';
  try {
    const {command,values,timeout}=parse(argv);
    if(command==='help'){stdout.write(help);return 0;}
    if(command==='check-cloud-restore-config') {
      phase='INVALID_CLOUD_RESTORE_CONFIG';signal?.throwIfAborted();
      const {config,credentialsConfigured}=await readCloudRestoreConfig(values.config,{environment,requireSecrets:false});
      stdout.write(JSON.stringify({command,environment:config.environment,valid:true,credentialsConfigured,resourcesVerified:false,writesPlaintext:true})+'\n');return 0;
    }
    if(command==='check-s3-restore-config') {
      phase='INVALID_S3_RESTORE_CONFIG';signal?.throwIfAborted();
      const {config,credentialsConfigured}=await readS3RestoreConfig(values.config,{environment,requireSecrets:false});
      stdout.write(JSON.stringify({command,environment:config.environment,valid:true,credentialsConfigured,resourcesVerified:false,writesPlaintext:true})+'\n');return 0;
    }
    if(command==='backup-offsite') {
      phase='INVALID_BACKUP_JOB_CONFIG';signal?.throwIfAborted();
      const backup=await readBackupConfig(values.config,{environment}),offsite=await readOffsiteConfig(values['offsite-config'],{environment});
      const schema=await schemaVersions(backup.config.schemaVersion),controller=new AbortController();
      timer=setTimeout(()=>controller.abort(),backup.config.maxRunMs+offsite.config.maxRunMs+30000);
      operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;phase='BACKUP_JOB_FAILED';
      const {runBackupJob}=await import('./backup-job.mjs');
      const result=await runBackupJob({directory:values['run-directory'],backup,offsite,schema,signal:operationSignal,backupDependencies,offsiteDependencies});
      stdout.write(JSON.stringify({command,...result})+'\n');return result.receipt==='PENDING'||result.offsiteReceipt==='PENDING'?3:0;
    }
    if(['check-offsite-config','upload-offsite','download-offsite'].includes(command)) {
      phase='INVALID_OFFSITE_CONFIG';signal?.throwIfAborted();
      const {config,credentials,credentialsConfigured}=await readOffsiteConfig(values.config,{environment,requireSecrets:command!=='check-offsite-config'});
      if(command==='check-offsite-config') {
        stdout.write(JSON.stringify({command,environment:config.environment,configurationValid:true,credentialsConfigured,resourcesVerified:false})+'\n');return 0;
      }
      const controller=new AbortController();timer=setTimeout(()=>controller.abort(),config.maxRunMs);
      operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      phase=command==='upload-offsite'?'OFFSITE_UPLOAD_FAILED':'OFFSITE_DOWNLOAD_FAILED';
      const {offsiteS3}=await import('./offsite-s3.mjs');
      const {uploadSnapshot,downloadSnapshot}=await import('./offsite-transfer.mjs');
      const store=offsiteS3({target:config.target,...credentials,requestHandler:offsiteDependencies.requestHandler});
      try {
        const report=command==='upload-offsite'?await uploadSnapshot({directory:values.snapshot,store,signal:operationSignal}):
          await downloadSnapshot({snapshotId:values['snapshot-id'],directory:values.target,store,signal:operationSignal});
        stdout.write(JSON.stringify({command,environment:config.environment,...report})+'\n');return 0;
      }finally{store.close();}
    }
    if(['backup','check-config'].includes(command)) {
      phase='INVALID_BACKUP_CONFIG';signal?.throwIfAborted();
      const loaded=await readBackupConfig(values.config,{environment,requireSecrets:command==='backup'});
      const schema=await schemaVersions(loaded.config.schemaVersion);
      if(command==='check-config') {
        stdout.write(JSON.stringify({command,environment:loaded.config.environment,configurationValid:true,credentialsConfigured:loaded.credentialsConfigured,
          resourcesVerified:false,schemaVersion:loaded.config.schemaVersion})+'\n');return 0;
      }
      phase='BACKUP_FAILED';
      const {configuredBackup}=await import('./configured-backup.mjs');
      const report=await configuredBackup({...loaded,schema,signal,fetcher:backupDependencies.fetcher,r2RequestHandler:backupDependencies.r2RequestHandler,s3RequestHandler:backupDependencies.s3RequestHandler});
      stdout.write(JSON.stringify({command,...report})+'\n');return report.receipt==='PENDING'?3:0;
    }
    const schema=await schemaVersions(values['schema-version']);
    const controller=new AbortController();timer=setTimeout(()=>controller.abort(),timeout);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    operationSignal=combined;
    const options={directory:resolve(values.snapshot),identityFile:resolve(values.identity),executable:values.age,
      legacyBackend:values['legacy-backend'],schema,signal:combined};
    let report;
    if(command==='restore-cloud') {
      phase='INVALID_CLOUD_RESTORE_CONFIG';const loaded=await readCloudRestoreConfig(values.config,{environment});
      phase='INVALID_LEDGER_FILE';const ledger=values.ledger?await ledgerFile(values.ledger):undefined;
      phase='CLOUD_RESTORE_FAILED';
      const {configuredCloudRestore}=await import('./configured-cloud-restore.mjs');
      report=await configuredCloudRestore({...options,...loaded,runDirectory:values['run-directory'],latestLedger:ledger?.entries,ledgerThrough:ledger?.ledgerThrough,
        fetcher:restoreDependencies.fetcher,r2RequestHandler:restoreDependencies.r2RequestHandler,s3RequestHandler:restoreDependencies.s3RequestHandler});
    } else if(command==='prune-cache') {
      phase='CACHE_PRUNE_FAILED';
      const loaded=await readBackupConfig(values.config,{environment,requireSecrets:false});
      const pathIdentity=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
      if(!loaded.config.cipherCache||!loaded.credentials.cacheKey||pathIdentity(loaded.config.destination)!==pathIdentity(options.directory))throw new Error();
      const {pruneCipherCache}=await import('./prune-cache.mjs');
      report=await pruneCipherCache({...options,cache:loaded.config.cipherCache.directory,key:loaded.credentials.cacheKey,recipient:loaded.config.recipient,catalogSha256:values['catalog-sha256']});
    } else if(command==='prune-local') {
      phase='LOCAL_PRUNE_FAILED';
      const {pruneLocalSnapshots}=await import('./prune-local.mjs');
      report=await pruneLocalSnapshots({...options,catalogSha256:values['catalog-sha256']});
    } else if(['plan-offsite-retention','prune-offsite'].includes(command)) {
      phase=command==='prune-offsite'?'OFFSITE_PRUNE_FAILED':'OFFSITE_RETENTION_REVIEW_FAILED';
      const {config,credentials}=await readOffsiteConfig(values.config,{environment});
      const {offsiteS3}=await import('./offsite-s3.mjs');
      const {reviewOffsiteRetention}=await import('./offsite-retention.mjs');
      const store=offsiteS3({target:config.target,...credentials,requestHandler:offsiteDependencies.requestHandler});
      options.signal=AbortSignal.any([combined,AbortSignal.timeout(config.maxRunMs)]);operationSignal=options.signal;
      try{
        if(command==='prune-offsite'){
          const {pruneOffsite}=await import('./prune-offsite.mjs');
          report=await pruneOffsite({...options,store,target:config.target,runDirectory:values['run-directory'],catalogSha256:values['catalog-sha256'],inventorySha256:values['inventory-sha256']});
        }else report=await reviewOffsiteRetention({...options,store});
      }finally{store.close();}
    } else if(command==='plan-retention') {
      phase='RETENTION_REVIEW_FAILED';
      const {reviewRetention}=await import('./retention-plan.mjs');
      report=await reviewRetention(options);
    } else if(command==='restore-local'||command==='restore-mixed') {
      phase='INVALID_LEDGER_FILE';const ledger=values.ledger?await ledgerFile(values.ledger):undefined;
      phase='RESTORE_FAILED';
      const {localRestoreTarget}=await import('./local-restore-target.mjs');
      let target=localRestoreTarget(values.target),expectedSnapshotId,restoreTimer;
      try {
        if(command==='restore-mixed') {
          phase='INVALID_S3_RESTORE_CONFIG';
          const {config,credentials}=await readS3RestoreConfig(values['s3-config'],{environment});
          const deadline=new AbortController();restoreTimer=setTimeout(()=>deadline.abort(),config.maxRunMs);
          options.signal=AbortSignal.any([combined,deadline.signal]);operationSignal=options.signal;expectedSnapshotId=config.snapshotId;
          const {s3RestoreObjects,composeS3RestoreTarget}=await import('./s3-restore-target.mjs');
          target=composeS3RestoreTarget(target,s3RestoreObjects({target:config.target,...credentials,requestHandler:restoreDependencies.s3RequestHandler}),{signal:options.signal});
        }
        phase='RESTORE_FAILED';
        report=await restoreBackup({...options,target,expectedSnapshotId,latestLedger:ledger?.entries,ledgerThrough:ledger?.ledgerThrough});
        if(command==='restore-mixed')report={...report,s3ObjectsVerified:true,writesPlaintext:true};
      }finally{clearTimeout(restoreTimer);await target.close();}
    } else {
      phase='SNAPSHOT_VERIFICATION_FAILED';
      const {manifest,ledger}=await verifyBackup(options);
      report={snapshotId:manifest.snapshotId,snapshotAt:manifest.snapshotAt,deletionLedgerThrough:manifest.deletionLedgerThrough,
        objects:manifest.objects.length,schemaVersion:manifest.schema.at(-1).version,verified:true,requiresAcceptance:true};
      if(command==='export-ledger'||command==='collect-ledger') {
        let data={version:1,ledgerThrough:manifest.deletionLedgerThrough,entries:ledger};
        if(command==='collect-ledger') {
          phase='LEDGER_COLLECTION_FAILED';
          const {config,credentials}=await readBackupConfig(values.config,{environment,requireSecrets:false});
          if(!credentials.r2AccessKeyId||!credentials.r2SecretAccessKey)throw new Error();
          const {r2Source}=await import('./r2-source.mjs'),{supplementLedger}=await import('./latest-ledger.mjs');
          const source=r2Source({accountId:config.accountId,bucket:config.bucket,accessKeyId:credentials.r2AccessKeyId,secretAccessKey:credentials.r2SecretAccessKey,metadataNames:config.metadataNames,requestHandler:backupDependencies.r2RequestHandler});
          try{data=await supplementLedger({ledger,ledgerThrough:data.ledgerThrough,source,signal:combined});}finally{source.close();}
          report.coverageAdvanced=false;report.r2SupplementCollected=true;
        }
        phase='LEDGER_WRITE_FAILED';combined.throwIfAborted();
        const content=JSON.stringify(data);
        if(Buffer.byteLength(content)>32*1024*1024)throw new Error();
        const output=resolve(values.output),temporary=join(dirname(output),`.ledger-${randomUUID()}.pending`);
        const file=await open(temporary,'wx',0o600);
        try {
          try {await file.writeFile(content);await file.sync();}finally {await file.close();}
          combined.throwIfAborted();await link(temporary,output);
        }finally {await unlink(temporary);}
        report.ledgerExported=true;
      }
    }
    stdout.write(JSON.stringify({command,...report})+'\n');return 0;
  } catch {
    stderr.write(JSON.stringify({error:operationSignal?.aborted?'OPERATION_ABORTED':phase})+'\n');return phase==='INVALID_ARGUMENTS'?2:1;
  } finally {clearTimeout(timer);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try {process.exitCode=await runCli(process.argv.slice(2),{signal:controller.signal});}
  finally {process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
