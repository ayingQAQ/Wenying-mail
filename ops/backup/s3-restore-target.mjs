import {createRequire} from 'node:module';
import {validateS3Target} from './s3-config.mjs';
import {s3Source} from './s3-source.mjs';
import {guardedObjectRestore} from './object-restore-target.mjs';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {GetBucketVersioningCommand,GetPublicAccessBlockCommand}=require('@aws-sdk/client-s3');
export function s3RestoreObjects(options) {
  validateS3Target(options.target);
  return guardedObjectRestore({...options,backend:'s3',reader:s3Source(options),
    validKey:key=>/^attachments\/[A-Za-z0-9_.-]+$/.test(key)&&key.length<=512&&!['.','..'].includes(key.slice(12)),
    async assertIsolated(send) {
      const versioning=await send(new GetBucketVersioningCommand({Bucket:options.target.bucket}));
      if(versioning.Status!==undefined)throw new Error('S3_RESTORE_FAILED');
      const {PublicAccessBlockConfiguration:block}=await send(new GetPublicAccessBlockCommand({Bucket:options.target.bucket}));
      if(!block||['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].some(key=>block[key]!==true))throw new Error('S3_RESTORE_FAILED');
    }});
}
export function composeS3RestoreTarget(base,objects,{signal}={}) {
  return {
    async begin(){try{await base.begin();await objects.begin({signal});}catch(error){await base.close();objects.close();throw error;}},
    putObject:(object,data)=>object.backend==='s3'?objects.putObject(object,data,{signal}):base.putObject(object,data),
    importDatabase:(sql,options)=>base.importDatabase(sql,options),
    async verify(contract,options){await base.verify(contract,options);await objects.verify({signal});},
    finish:report=>base.finish({...report,s3ObjectsVerified:true}),
    async close(){try{await base.close();}finally{objects.close();}},
  };
}
