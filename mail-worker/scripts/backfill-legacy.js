import {openLocalDatabase} from './local-database.js';
import {backfillLegacyBatch} from '../src/processing/legacy-backfill.js';
import {legacyStorageConfig} from '../src/vps/legacy-config.js';
const args=process.argv.slice(2);let proxy;
try {
  if(args.length!==4||args[0]!=='--local'||args[1]!=='--writers-stopped'||args[2]!=='--legacy-backend'||!['kv','r2','s3'].includes(args[3]))
    throw new Error('INVALID_BACKFILL_ARGUMENTS');
  const legacy=legacyStorageConfig({...process.env,LEGACY_MAIL_STORAGE:args[3]});
  proxy=await openLocalDatabase();
  const result=await backfillLegacyBatch({...proxy.env,...legacy},{writersStopped:true});
  console.log(JSON.stringify({target:'local-only',...result}));
} catch(error){
  const safe=['INVALID_BACKFILL_ARGUMENTS','BACKFILL_SOURCE_UNAVAILABLE','BACKFILL_SOURCE_INVALID','BACKFILL_SOURCE_LIMIT',
    'BACKFILL_SOURCE_CHANGED','BACKFILL_OBJECT_CONFLICT','STORAGE_LOCK_LOST','LEGACY_ATTACHMENT_UNAVAILABLE'];
  console.error(safe.includes(error.message)?error.message:'LOCAL_BACKFILL_FAILED');process.exitCode=1;
} finally{await proxy?.dispose();}
