import {cloudApi} from './cloud-api.js';
import {remoteD1} from './d1.js';
import {localD1} from './local-db.js';
import {admissionDirectory} from './admission-directory.js';
import {remoteR2} from './r2.js';
import {cachedDerivedStorage} from './derived-cache.js';
import {remoteKV} from './kv.js';
import {localKV} from './local-kv.js';
import {remoteQueue} from './queues.js';
import {privateBindAddress} from './bind-address.js';
import {legacyStorageConfig} from './legacy-config.js';
import {transportSignal} from './work-budget.js';
import {telegramConfig} from '../service/telegram-notification.js';

export function runtimeConfig(source){
  const required=name=>{const value=source[name];if(typeof value!=='string'||!value||value.trim()!==value)throw new Error(`MISSING_OR_INVALID_${name}`);return value;};
  const integer=(name,fallback,min,max)=>{const value=Number(source[name]??fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`INVALID_${name}`);return value;};
  const flag=name=>{if(source[name]!==undefined&&!['true','false'].includes(source[name]))throw new Error(`INVALID_${name}`);return source[name]==='true';};
  if(source.VPS_API_ORIGIN)throw new Error('VPS_PROXY_LOOP');
  if(source.MAIL_AUTH_MODE!==undefined&&!['access','password','either'].includes(source.MAIL_AUTH_MODE))throw new Error('INVALID_MAIL_AUTH_MODE');
  const accountId=required('MAIL_CLOUDFLARE_ACCOUNT'),token=required('CLOUDFLARE_API_TOKEN');
  const request=cloudApi({accountId,token});
  const domain=required('MAIL_DOMAINS').split(',');
  if(domain.some(value=>! /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)))throw new Error('INVALID_MAIL_DOMAINS');
  const env={MAIL_AUTH_MODE:source.MAIL_AUTH_MODE??'access',APP_ORIGIN:required('APP_ORIGIN'),ACCESS_TEAM_DOMAIN:source.ACCESS_TEAM_DOMAIN??'',ACCESS_AUD:source.ACCESS_AUD??'',
    BACKUP_ACCESS_AUD:source.BACKUP_ACCESS_AUD??'',BACKUP_ACCESS_CLIENT_ID:source.BACKUP_ACCESS_CLIENT_ID??'',
    domain,admin:source.MAIL_ADMIN_EMAIL??'',MAIL_CLOUDFLARE_ACCOUNT:accountId,MAIL_R2_BUCKET:required('MAIL_R2_BUCKET'),
    MAIL_QUEUE_NAME:required('MAIL_QUEUE_NAME'),MAIL_DLQ_NAME:source.MAIL_DLQ_NAME??'',
    assets:{fetch:()=>new Response(null,{status:404})},
    ...legacyStorageConfig(source),STORAGE_SIGNAL_FACTORY:transportSignal,
    TELEGRAM_NOTIFICATION:telegramConfig(source),
  };
  for(const name of ['MAIL_RECOVERY_ENABLED','MAIL_DELETION_ENABLED','MAIL_TRASH_EXPIRY_ENABLED','MAIL_PURGE_ENABLED','MAIL_GENERATION_GC_ENABLED'])env[name]=String(flag(name));
  const port=integer('VPS_PORT',18766,1024,65535),maxActive=integer('VPS_MAX_ACTIVE',8,1,32);
  const bindAddress=privateBindAddress(source.VPS_BIND_ADDRESS);
  const ingressHost=required('VPS_INGRESS_HOST'),originToken=required('VPS_PROXY_TOKEN');
  const backend=source.MAIL_DB_BACKEND??'d1';
  if(!['d1','sqlite'].includes(backend))throw new Error('INVALID_MAIL_DB_BACKEND');
  // Switching requires an explicitly imported, verified database; a typo must
  // never launch the mail application against an empty replacement file.
  const sqlitePath=backend==='sqlite'?required('MAIL_SQLITE_PATH'):undefined;
  if(backend==='d1')env.db=remoteD1({databaseId:required('MAIL_D1_ID'),request});
  if(backend==='d1')env.kv=remoteKV({accountId,namespaceId:required('MAIL_KV_ID'),token});
  env.MAIL_QUEUE=remoteQueue({queueId:required('MAIL_QUEUE_ID'),queueName:env.MAIL_QUEUE_NAME,request});
  const queues=[env.MAIL_QUEUE];
  if(source.MAIL_DLQ_ID){if(!env.MAIL_DLQ_NAME)throw new Error('MISSING_MAIL_DLQ_NAME');queues.push(remoteQueue({queueId:source.MAIL_DLQ_ID,queueName:env.MAIL_DLQ_NAME,request}));}
  const consume=flag('VPS_QUEUE_ENABLED'),maintenance=flag('VPS_MAINTENANCE_ENABLED');
  const wakeToken=source.VPS_WAKE_TOKEN;
  if(wakeToken!==undefined&&!/^[a-f0-9]{64}$/.test(wakeToken))throw new Error('INVALID_WAKE_TOKEN');
  if(consume&&queues.length!==2)throw new Error('DLQ_REQUIRED_FOR_CONSUMER');
  env.r2=cachedDerivedStorage(remoteR2({accountId,bucket:env.MAIL_R2_BUCKET,accessKeyId:required('R2_ACCESS_KEY_ID'),secretAccessKey:required('R2_SECRET_ACCESS_KEY')}));
  if(backend==='sqlite')try{
    env.kv=localKV(required('MAIL_KV_SQLITE_PATH'));
    const sync=flag('VPS_ADMISSION_SYNC_ENABLED');
    if(consume&&!sync)throw new Error('SQLITE_ADMISSION_SYNC_REQUIRED');
    const directory=sync?admissionDirectory(remoteD1({databaseId:required('MAIL_ADMISSION_D1_ID'),request:cloudApi({accountId,token,timeoutMs:5000})})):undefined;
    env.db=localD1({path:sqlitePath,create:false,admission:directory});
  }catch(error){env.r2.close();env.kv?.close?.();throw error;}
  return {env,port,bindAddress,maxActive,ingressHost,originToken,wakeToken,queues,consume,maintenance,close:()=>{env.r2.close();env.db.close?.();env.kv.close?.();}};
}
