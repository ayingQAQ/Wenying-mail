import {open} from 'node:fs/promises';
import {resolve,dirname,isAbsolute,sep} from 'node:path';
import {metadataNamesMap} from './metadata-names.mjs';
import {validateS3Target} from './s3-config.mjs';
const invalid=()=>{throw new Error('INVALID_BACKUP_CONFIG');};
const required=['version','environment','accountId','databaseId','bucket','holdOrigin','downloadOrigins','recipient','executable','destination','maxRunMs','schemaVersion','appCommit','appSourceSha256','credentialEnv'];
const secrets=['r2AccessKeyId','r2SecretAccessKey','d1Token','accessClientId','accessClientSecret'];
function exact(value,keys,optional=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...keys,...optional].includes(key)))invalid();
}
function origin(value) {try{const url=new URL(value);if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)invalid();return value;}catch{invalid();}}
export async function readBackupConfig(path,{environment=process.env,requireSecrets=true}={}) {
  path=resolve(path);const file=await open(path,'r'),buffer=Buffer.alloc(65537);let length=0;
  try {
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  }finally{await file.close();}
  if(length>65536)invalid();
  let value;try{value=JSON.parse(buffer.subarray(0,length).toString('utf8'));}catch{invalid();}
  exact(value,required,['metadataNames','legacyBackend','legacyKv','legacyS3','cipherCache']);
  const credentialKeys=[...secrets,...(value.legacyKv?['kvToken']:[]),...(value.legacyS3?['s3AccessKeyId','s3SecretAccessKey']:[]),...(value.cipherCache?['cacheKey']:[])];exact(value.credentialEnv,credentialKeys);
  if(value.cipherCache!==undefined){exact(value.cipherCache,['directory']);if(typeof value.cipherCache.directory!=='string'||!value.cipherCache.directory||/[\x00-\x1f]/.test(value.cipherCache.directory))invalid();}
  if(value.legacyS3!==undefined)validateS3Target(value.legacyS3);
  if(value.legacyKv!==undefined){exact(value.legacyKv,['namespaceId']);if(!/^[a-f0-9]{32}$/.test(value.legacyKv.namespaceId))invalid();}
  if(value.version!==1||!['staging','production'].includes(value.environment)||!/^[a-f0-9]{32}$/.test(value.accountId)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.databaseId)||!/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.test(value.bucket)||
    !/^age1[0-9a-z]{58}$/.test(value.recipient)||!Number.isSafeInteger(value.maxRunMs)||value.maxRunMs<1||value.maxRunMs>14400000||
    !Number.isSafeInteger(value.schemaVersion)||value.schemaVersion<1||!/^[a-f0-9]{40}$/.test(value.appCommit)||!/^[a-f0-9]{64}$/.test(value.appSourceSha256)||
    typeof value.destination!=='string'||!value.destination||typeof value.executable!=='string'||!value.executable||/[\x00-\x1f]/.test(value.destination+value.executable)||
    (value.legacyBackend!==undefined&&value.legacyBackend!=='r2'&&!(value.legacyBackend==='kv'&&value.legacyKv)&&!(value.legacyBackend==='s3'&&value.legacyS3)))invalid();
  origin(value.holdOrigin);
  if(!Array.isArray(value.downloadOrigins)||!value.downloadOrigins.length||value.downloadOrigins.length>10)invalid();
  value.downloadOrigins.forEach(origin);
  const mapping=value.metadataNames??{};
  metadataNamesMap(mapping);
  const references=Object.values(value.credentialEnv);
  if(new Set(references).size!==credentialKeys.length||references.some(name=>typeof name!=='string'||!/^MAIL_BACKUP_[A-Z0-9_]{1,100}$/.test(name)))invalid();
  const credentials={},missing=[];
  for(const key of credentialKeys) {
    const secret=environment[value.credentialEnv[key]];
    if(typeof secret!=='string'||!secret||secret.length>4096||/[\r\n\x00]/.test(secret))missing.push(key);
    else credentials[key]=secret;
  }
  if(requireSecrets&&missing.length)throw new Error('BACKUP_CREDENTIALS_MISSING');
  if(credentials.cacheKey&&!/^[a-f0-9]{64}$/.test(credentials.cacheKey))invalid();
  const base=dirname(path);
  if(value.cipherCache){
    value.cipherCache.directory=resolve(base,value.cipherCache.directory);
    const normalize=path=>process.platform==='win32'?path.toLowerCase():path;
    const cache=normalize(value.cipherCache.directory)+sep,destination=normalize(resolve(base,value.destination))+sep;
    if(cache.startsWith(destination)||destination.startsWith(cache))invalid();
  }
  return {config:{...value,destination:resolve(base,value.destination),metadataNames:mapping,
    executable:isAbsolute(value.executable)||!/[\\/]/.test(value.executable)?value.executable:resolve(base,value.executable)},
    credentials,credentialsConfigured:missing.length===0};
}
