import {guardedObjectRestore} from './object-restore-target.mjs';
import {r2Source} from './r2-source.mjs';
import {r2RestoreIsolation} from './r2-restore-isolation.mjs';
const fail=()=>{throw new Error('R2_RESTORE_ISOLATION_FAILED');};
export function r2RestoreObjects({accountId,bucket,apiToken,accessKeyId,secretAccessKey,metadataNames={},requestHandler,fetcher=fetch,maxObjects=1000000}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||! /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||
    typeof apiToken!=='string'||!apiToken||apiToken.length>4096||/[\r\n\x00]/.test(apiToken))fail();
  const target={endpoint:`https://${accountId}.r2.cloudflarestorage.com`,bucket,region:'auto',forcePathStyle:true,metadataNames};
  const assertIsolated=r2RestoreIsolation({accountId,bucket,apiToken,fetcher});
  return guardedObjectRestore({target,accessKeyId,secretAccessKey,requestHandler,maxObjects,backend:'r2',recheckBeforeWrite:true,requireStoredSha256:true,
    reader:r2Source({accountId,bucket,accessKeyId,secretAccessKey,metadataNames,requestHandler,requireSha256:true}),
    validKey:key=>key.length<=1024&&!/[\x00-\x1f]/.test(key)&&/^(raw|derived|inline|attachments|tombstones)\//.test(key)&&!key.split('/').some(part=>!part||part==='.'||part==='..'),
    assertIsolated:(_send,signal)=>assertIsolated(signal)});
}
