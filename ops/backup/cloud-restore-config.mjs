import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {metadataNamesMap} from './metadata-names.mjs';
import {validateS3Target} from './s3-config.mjs';
const fail=()=>{throw Error('INVALID_CLOUD_RESTORE_CONFIG');};
const exact=(value,keys,optional=[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...keys,...optional].includes(key)))fail();};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const bucket=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);
export async function readCloudRestoreConfig(path,{environment=process.env,requireSecrets=true}={}) {
  const file=await open(resolve(path),'r'),buffer=Buffer.alloc(65537);let size=0,value;
  try{while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}}finally{await file.close();}
  if(size>65536)fail();try{value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{fail();}
  exact(value,['version','purpose','environment','snapshotId','accountId','d1','r2','maxRunMs','credentialEnv'],['kv','s3']);
  exact(value.d1,['sourceDatabaseId','databaseId','databaseName','uploadOrigins']);exact(value.r2,['sourceBucket','bucket'],['metadataNames']);
  if(value.version!==1||value.purpose!=='restore-isolated-cloud'||!['staging','production'].includes(value.environment)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.snapshotId)||!/^[a-f0-9]{32}$/.test(value.accountId)||
    !uuid(value.d1.sourceDatabaseId)||!uuid(value.d1.databaseId)||value.d1.sourceDatabaseId===value.d1.databaseId||
    typeof value.d1.databaseName!=='string'||!value.d1.databaseName||value.d1.databaseName.length>128||/[\x00-\x1f]/.test(value.d1.databaseName)||
    !bucket(value.r2.sourceBucket)||!bucket(value.r2.bucket)||value.r2.sourceBucket===value.r2.bucket||
    !Number.isSafeInteger(value.maxRunMs)||value.maxRunMs<1||value.maxRunMs>86400000)fail();
  const origins=value.d1.uploadOrigins;
  if(!Array.isArray(origins)||!origins.length||origins.length>10||new Set(origins).size!==origins.length)fail();
  // Only explicit Cloudflare global R2 upload origins, never an arbitrary host
  // from an API response. D1's upload account can differ from the user's account.
  for(const origin of origins)if(typeof origin!=='string'||!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(origin))fail();
  metadataNamesMap(value.r2.metadataNames??{});
  if(value.kv!==undefined){exact(value.kv,['sourceNamespaceId']);if(!/^[a-f0-9]{32}$/.test(value.kv.sourceNamespaceId))fail();}
  if(value.s3!==undefined)validateS3Target(value.s3);
  const keys=['apiToken','r2AccessKeyId','r2SecretAccessKey',...(value.s3?['s3AccessKeyId','s3SecretAccessKey']:[])];exact(value.credentialEnv,keys);
  const refs=Object.values(value.credentialEnv);
  if(new Set(refs).size!==keys.length||refs.some(name=>typeof name!=='string'||!/^MAIL_RESTORE_[A-Z0-9_]{1,100}$/.test(name)))fail();
  const credentials={};let credentialsConfigured=true;
  for(const [key,name] of Object.entries(value.credentialEnv)){
    const secret=environment[name];
    if(typeof secret!=='string'||!secret||secret.length>4096||/[\s\x00]/.test(secret))credentialsConfigured=false;
    else credentials[key]=secret;
  }
  if(requireSecrets&&!credentialsConfigured)throw Error('CLOUD_RESTORE_CREDENTIALS_MISSING');
  return {config:value,credentials,credentialsConfigured};
}
