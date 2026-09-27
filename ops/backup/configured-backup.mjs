import {cloudSource} from './cloud-source.mjs';
import {backupHoldClient} from './hold-client.mjs';
import {runBackup} from './backup.mjs';
import {kvSource} from './kv-source.mjs';
import {s3Source} from './s3-source.mjs';
import {openCipherCache} from './cipher-cache.mjs';

export async function configuredBackup({config,credentials,schema,signal,fetcher=fetch,r2RequestHandler,s3RequestHandler,snapshotId}) {
  let source,cipherCache;
  try {
  if(config.cipherCache)cipherCache=await openCipherCache({root:config.cipherCache.directory,key:credentials.cacheKey,recipient:config.recipient});
  source=cloudSource({r2:{accountId:config.accountId,bucket:config.bucket,metadataNames:config.metadataNames,
    accessKeyId:credentials.r2AccessKeyId,secretAccessKey:credentials.r2SecretAccessKey,requestHandler:r2RequestHandler},
    d1:{accountId:config.accountId,databaseId:config.databaseId,token:credentials.d1Token,downloadOrigins:config.downloadOrigins,fetcher},
    legacy:{...(config.legacyKv?{kv:kvSource({accountId:config.accountId,namespaceId:config.legacyKv.namespaceId,token:credentials.kvToken,fetcher})}:{}),
      ...(config.legacyS3?{s3:s3Source({target:config.legacyS3,accessKeyId:credentials.s3AccessKeyId,secretAccessKey:credentials.s3SecretAccessKey,requestHandler:s3RequestHandler})}:{})}});
    const holdClient=backupHoldClient({origin:config.holdOrigin,clientId:credentials.accessClientId,clientSecret:credentials.accessClientSecret,fetcher});
    const result=await runBackup({source,holdClient,schema,signal,root:config.destination,executable:config.executable,recipient:config.recipient,
      appCommit:config.appCommit,appSourceSha256:config.appSourceSha256,legacyBackend:config.legacyBackend,maxRunMs:config.maxRunMs,cipherCache,snapshotId});
    return {snapshotId:result.snapshotId,environment:config.environment,encryptedSnapshotComplete:true,receipt:result.receipt,
      requiresRestoreAcceptance:true};
  } finally {try{source?.close();}finally{await cipherCache?.close();}}
}
