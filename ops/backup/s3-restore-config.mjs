import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateS3Target} from './s3-config.mjs';
const fail=()=>{throw new Error('INVALID_S3_RESTORE_CONFIG');};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail();};
export async function readS3RestoreConfig(path,{environment=process.env,requireSecrets=true}={}) {
  const file=await open(resolve(path),'r'),buffer=Buffer.alloc(65537);let size=0,value;
  try{while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}}finally{await file.close();}
  if(size>65536)fail();try{value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{fail();}
  exact(value,['version','purpose','environment','snapshotId','target','maxRunMs','credentialEnv']);exact(value.credentialEnv,['accessKeyId','secretAccessKey']);
  if(value.version!==1||value.purpose!=='restore-plaintext-attachments'||!['staging','production'].includes(value.environment)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.snapshotId)||
    !Number.isSafeInteger(value.maxRunMs)||value.maxRunMs<1||value.maxRunMs>86400000)fail();
  validateS3Target(value.target);
  const refs=Object.values(value.credentialEnv);
  if(new Set(refs).size!==2||refs.some(name=>typeof name!=='string'||!/^MAIL_RESTORE_[A-Z0-9_]{1,100}$/.test(name)))fail();
  const credentials={};let credentialsConfigured=true;
  for(const [key,name] of Object.entries(value.credentialEnv)) {
    const secret=environment[name];
    if(typeof secret!=='string'||!secret||secret.length>4096||/[\r\n\x00]/.test(secret))credentialsConfigured=false;
    else credentials[key]=secret;
  }
  if(requireSecrets&&!credentialsConfigured)throw new Error('S3_RESTORE_CREDENTIALS_MISSING');
  return {config:value,credentials,credentialsConfigured};
}
