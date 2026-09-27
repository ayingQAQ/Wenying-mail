import {metadataNamesMap} from './metadata-names.mjs';
export function validateS3Target(value) {
  const fail=()=>{throw new Error('INVALID_S3_SOURCE_CONFIG');};
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  const required=['endpoint','bucket','region','forcePathStyle'];
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,'metadataNames'].includes(key)))fail();
  let url;try{url=new URL(value.endpoint);}catch{fail();}
  if(url.protocol!=='https:'||url.origin!==value.endpoint||url.username||url.password||
    typeof value.bucket!=='string'||! /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)||value.bucket.includes('..')||
    typeof value.region!=='string'||! /^[a-z0-9-]{1,64}$/.test(value.region)||typeof value.forcePathStyle!=='boolean')fail();
  metadataNamesMap(value.metadataNames??{});return value;
}
