import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {validateS3Target} from './s3-config.mjs';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {S3Client,GetPublicAccessBlockCommand,GetObjectCommand,PutObjectCommand,ListObjectsV2Command,DeleteObjectCommand,GetBucketVersioningCommand,GetBucketLifecycleConfigurationCommand}=require('@aws-sdk/client-s3');
export const OFFSITE_LOCK_KEY='.mail-backup/write-lock.json';
const fail=()=>{throw new Error('OFFSITE_STORAGE_FAILED');};
const valid=key=>/^(blobs\/[a-f0-9-]{36}\.age|snapshots\/[a-f0-9-]{36}\/transport.json)$/.test(key);
export function offsiteS3({target,accessKeyId,secretAccessKey,requestHandler}) {
  validateS3Target(target);
  if([accessKeyId,secretAccessKey].some(value=>typeof value!=='string'||!value||/[\r\n\x00]/.test(value)))fail();
  const client=new S3Client({endpoint:target.endpoint,region:target.region,forcePathStyle:target.forcePathStyle,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId,secretAccessKey},...(requestHandler?{requestHandler}:{}),requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const bodies=new Set();let ready=false,closed=false,lock;
  async function send(command,signal){if(closed||!signal)fail();signal.throwIfAborted();return client.send(command,{abortSignal:signal});}
  async function assertLock(signal){
    if(!lock)throw Error('OFFSITE_LOCK_REQUIRED');
    const object=await send(new GetObjectCommand({Bucket:target.bucket,Key:OFFSITE_LOCK_KEY}),signal);
    try{
      if(object.ContentLength!==lock.bytes.length||typeof object.ETag!=='string'||!object.ETag||!object.Body?.[Symbol.asyncIterator])throw Error('OFFSITE_LOCK_LOST');
      const chunks=[];let size=0;for await(const chunk of object.Body){signal.throwIfAborted();size+=chunk.length;if(size>lock.bytes.length)throw Error('OFFSITE_LOCK_LOST');chunks.push(Buffer.from(chunk));}
      if(!Buffer.concat(chunks).equals(lock.bytes))throw Error('OFFSITE_LOCK_LOST');return object.ETag;
    }finally{object.Body?.destroy?.();}
  }
  return {
    targetIdentitySha256:createHash('sha256').update(JSON.stringify([target.endpoint,target.bucket,target.region,target.forcePathStyle])).digest('hex'),
    async begin(signal){try {
      const {PublicAccessBlockConfiguration:block}=await send(new GetPublicAccessBlockCommand({Bucket:target.bucket}),signal);
      if(!block||['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].some(key=>block[key]!==true))fail();ready=true;
    }catch{fail();}},
    async withWriteLock(action,signal){
      if(!ready||lock||typeof action!=='function')throw Error('OFFSITE_LOCK_REQUIRED');
      lock={bytes:Buffer.from(JSON.stringify({version:1,owner:randomUUID()})),uncertain:false};let acquired=false;
      try{
        try{await send(new PutObjectCommand({Bucket:target.bucket,Key:OFFSITE_LOCK_KEY,Body:lock.bytes,ContentLength:lock.bytes.length,IfNoneMatch:'*',ContentType:'application/json'}),signal);}
        catch(error){if(error.$metadata?.httpStatusCode===412)throw Error('OFFSITE_COLLECTION_BUSY');throw Error('OFFSITE_LOCK_ACQUIRE_UNCERTAIN');}
        acquired=true;await assertLock(signal);
        return await action({assertHeld:()=>assertLock(signal),publicationStarted(){lock.uncertain=true;},publicationVerified(){lock.uncertain=false;}});
      }finally{
        try{
          // No expiry/automatic takeover. An uncertain publication or killed
          // process must be investigated before this marker is removed.
          if(acquired&&!lock.uncertain){const cleanup=AbortSignal.timeout(10000),etag=await assertLock(cleanup);await send(new DeleteObjectCommand({Bucket:target.bucket,Key:OFFSITE_LOCK_KEY,IfMatch:etag}),cleanup);}
        }finally{lock=undefined;}
      }
    },
    async get(key,signal){if(!ready||!valid(key))fail();let object;
      try{object=await send(new GetObjectCommand({Bucket:target.bucket,Key:key}),signal);}catch(error){
        if(error.$metadata?.httpStatusCode===404&&['NoSuchKey','NotFound'].includes(error.name))return null;fail();
      }
      bodies.add(object.Body);const cancel=()=>{object.Body?.destroy?.();bodies.delete(object.Body);};
      if(!Number.isSafeInteger(object.ContentLength)||object.ContentLength<0||!object.Body?.[Symbol.asyncIterator]){cancel();fail();}
      return {size:object.ContentLength,body:object.Body,cancel};
    },
    async assertPrunable(signal){
      await assertLock(signal);
      const versioning=await send(new GetBucketVersioningCommand({Bucket:target.bucket}),signal);
      if(versioning.Status!==undefined)throw Error('OFFSITE_VERSIONING_UNSUPPORTED');
      try{const lifecycle=await send(new GetBucketLifecycleConfigurationCommand({Bucket:target.bucket}),signal);
        if(!Array.isArray(lifecycle.Rules)||lifecycle.Rules.some(rule=>rule.Status!=='Disabled'))throw Error('OFFSITE_LIFECYCLE_UNSUPPORTED');
      }catch(error){if(error.$metadata?.httpStatusCode!==404||error.name!=='NoSuchLifecycleConfiguration')throw error;}
    },
    async remove(key,etag,signal){
      if(!ready||!valid(key)||typeof etag!=='string'||!etag)fail();await assertLock(signal);
      try{await send(new DeleteObjectCommand({Bucket:target.bucket,Key:key,IfMatch:etag}),signal);}catch{throw Error('OFFSITE_DELETE_UNCERTAIN');}
    },
    async inventory(signal,{maxObjects=100000}={}){
      if(!ready||!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1000000)fail();
      const rows=[],seen=new Set(),cursors=new Set();let cursor;
      for(let pageNumber=0;pageNumber<=Math.ceil(maxObjects/1000);pageNumber++){
        const page=await send(new ListObjectsV2Command({Bucket:target.bucket,MaxKeys:1000,...(cursor?{ContinuationToken:cursor}:{})}),signal);
        const items=page.Contents??[];
        if(page.KeyCount!==items.length||items.length>1000||page.CommonPrefixes?.length||typeof page.IsTruncated!=='boolean')fail();
        for(const item of items){
          if(item.Key===OFFSITE_LOCK_KEY){await assertLock(signal);continue;}
          if(!valid(item.Key)||seen.has(item.Key)||!Number.isSafeInteger(item.Size)||item.Size<0||typeof item.ETag!=='string'||!item.ETag)fail();
          seen.add(item.Key);rows.push({key:item.Key,size:item.Size,etag:item.ETag});if(rows.length>maxObjects)fail();
        }
        if(!page.IsTruncated)return rows.sort((a,b)=>a.key.localeCompare(b.key));
        cursor=page.NextContinuationToken;if(typeof cursor!=='string'||!cursor||cursors.has(cursor))fail();cursors.add(cursor);
      }
      fail();
    },
    async put(key,{body,size,sha256},signal){if(!ready||!valid(key)||!Number.isSafeInteger(size)||size<0||!/^[a-f0-9]{64}$/.test(sha256))fail();
      try {await assertLock(signal);await send(new PutObjectCommand({Bucket:target.bucket,Key:key,Body:body,ContentLength:size,IfNoneMatch:'*',ChecksumSHA256:Buffer.from(sha256,'hex').toString('base64'),ContentType:'application/octet-stream'}),signal);}
      catch(error){if(error.$metadata?.httpStatusCode!==412)fail();}
      finally{body?.destroy?.();}
    },
    close(){closed=true;for(const body of bodies)body?.destroy?.();bodies.clear();client.destroy();},
  };
}
