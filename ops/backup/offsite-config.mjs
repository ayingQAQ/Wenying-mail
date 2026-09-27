import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateS3Target} from './s3-config.mjs';
const fail=()=>{throw new Error('INVALID_OFFSITE_CONFIG');};
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))fail();}
export async function readOffsiteConfig(path,{environment=process.env,requireSecrets=true}={}) {
  const file=await open(resolve(path),'r'),buffer=Buffer.alloc(65537);let size=0,value;
  try{while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}}
  finally{await file.close();}
  if(size>65536)fail();try{value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{fail();}
  fields(value,['version','environment','target','maxRunMs','credentialEnv']);fields(value.credentialEnv,['accessKeyId','secretAccessKey']);
  if(value.version!==1||!['staging','production'].includes(value.environment)||!Number.isSafeInteger(value.maxRunMs)||value.maxRunMs<1||value.maxRunMs>86400000)fail();
  validateS3Target(value.target);
  const references=Object.values(value.credentialEnv);
  if(new Set(references).size!==2||references.some(name=>typeof name!=='string'||!/^MAIL_OFFSITE_[A-Z0-9_]{1,100}$/.test(name)))fail();
  const credentials={};let credentialsConfigured=true;
  for(const [key,name] of Object.entries(value.credentialEnv)) {
    const secret=environment[name];
    if(typeof secret!=='string'||!secret||secret.length>4096||/[\r\n\x00]/.test(secret))credentialsConfigured=false;
    else credentials[key]=secret;
  }
  if(requireSecrets&&!credentialsConfigured)throw new Error('OFFSITE_CREDENTIALS_MISSING');
  return {config:value,credentials,credentialsConfigured};
}
