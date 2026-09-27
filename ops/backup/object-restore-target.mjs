import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {metadataNamesMap} from './metadata-names.mjs';

const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {S3Client,ListObjectsV2Command,PutObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const hash=data=>createHash('sha256').update(data).digest('hex');
const reservationKey='.mail-restore/reservation.json';
const fail=()=>{throw new Error('S3_RESTORE_FAILED');};

// Object target only, composed with a separate fresh D1/R2/KV target. Never
// creates buckets, deletes data, resumes an interrupted bucket or enables mail.
export function guardedObjectRestore({target,accessKeyId,secretAccessKey,requestHandler,maxObjects=1000000,backend,reader,validKey,assertIsolated,recheckBeforeWrite=false,requireStoredSha256=false}) {
  const names=metadataNamesMap(target.metadataNames??{});
  if(!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1000000)fail();

  const client=new S3Client({endpoint:target.endpoint,region:target.region,forcePathStyle:target.forcePathStyle,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId,secretAccessKey},...(requestHandler?{requestHandler}:{}),requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const reservation=Buffer.from(JSON.stringify({version:1,owner:randomUUID()})),written=new Map();let state='NEW';
  async function operation(expected,working,done,action){
    if(state!==expected)fail();state=working;
    try{await action();if(state!==working)fail();state=done;}
    catch(error){if(state!=='CLOSED')state='FAILED';throw error;}
  }
  async function send(command,signal){if(!signal||state==='CLOSED')fail();signal.throwIfAborted();try{return await client.send(command,{abortSignal:signal});}catch{fail();}}
  async function isolated(signal) {await assertIsolated(command=>send(command,signal),signal);}
  async function ownership(signal) {
    const result=await send(new GetObjectCommand({Bucket:target.bucket,Key:reservationKey}),signal);let size=0;const chunks=[];
    try {
      if(result.ContentLength!==reservation.length||!result.Body?.[Symbol.asyncIterator])fail();
      for await(const chunk of result.Body){signal.throwIfAborted();const bytes=Buffer.from(chunk);size+=bytes.length;if(size>reservation.length)fail();chunks.push(bytes);}
      if(!Buffer.concat(chunks).equals(reservation))fail();
    }finally{result.Body?.destroy?.();}
  }
  return {
    async begin({signal}={}) {
      return operation('NEW','STARTING','READY',async()=>{
      await isolated(signal);
      const page=await send(new ListObjectsV2Command({Bucket:target.bucket,MaxKeys:1}),signal);
      if(page.IsTruncated!==false||page.KeyCount!==0||page.Contents?.length||page.CommonPrefixes?.length)fail();
      await send(new PutObjectCommand({Bucket:target.bucket,Key:reservationKey,Body:reservation,IfNoneMatch:'*',ContentType:'application/json'}),signal);
      await ownership(signal);
      });
    },
    async putObject(object,data,{signal}={}) {
      return operation('READY','WRITING','READY',async()=>{
      if(object.backend!==backend||typeof object.key!=='string'||!validKey(object.key)||
        written.has(object.key)||written.size>=maxObjects||!Buffer.isBuffer(data)||data.length>25*1024*1024)fail();
      const metadata=object.customMetadata,http=object.httpMetadata;
      if(!metadata||!http||Object.entries(metadata).some(([key,value])=>names.get(key.toLowerCase())!==key||typeof value!=='string'))fail();
      const mapping={contentType:'ContentType',contentLanguage:'ContentLanguage',contentDisposition:'ContentDisposition',contentEncoding:'ContentEncoding',cacheControl:'CacheControl',cacheExpiry:'Expires'},fields={};
      for(const [key,value] of Object.entries(http)) {
        if(!mapping[key]||typeof value!=='string')fail();
        fields[mapping[key]]=key==='cacheExpiry'?new Date(value):value;
        if(key==='cacheExpiry'&&!Number.isFinite(fields.Expires.getTime()))fail();
      }
      if(recheckBeforeWrite)await isolated(signal);
      await ownership(signal);
      const sha256=hash(data);
      await send(new PutObjectCommand({Bucket:target.bucket,Key:object.key,Body:data,ContentLength:data.length,IfNoneMatch:'*',Metadata:metadata,...fields,
        ...(requireStoredSha256?{ChecksumSHA256:Buffer.from(sha256,'hex').toString('base64')}:{})}),signal);
      written.set(object.key,{size:data.length,sha256,customMetadata:structuredClone(metadata),httpMetadata:structuredClone(http)});
      });
    },
    async verify({signal}={}) {
      return operation('READY','VERIFYING','VERIFIED',async()=>{
      await isolated(signal);await ownership(signal);
      for(const [key,expected] of written) {
        const object=await reader.readObject(backend,key,signal),digest=createHash('sha256');let size=0;
        try{for await(const chunk of object.body){size+=chunk.length;digest.update(chunk);}}
        finally{object.cancel();}
        if(size!==expected.size||digest.digest('hex')!==expected.sha256||requireStoredSha256&&object.sha256!==expected.sha256||
          !isDeepStrictEqual({...object.customMetadata},expected.customMetadata)||!isDeepStrictEqual(object.httpMetadata,expected.httpMetadata))fail();
      }
      const expected=new Set([reservationKey,...written.keys()]),seen=new Set(),cursors=new Set();let cursor;
      for(let pageNumber=0;pageNumber<=Math.ceil((maxObjects+1)/1000);pageNumber++) {
        const page=await send(new ListObjectsV2Command({Bucket:target.bucket,MaxKeys:1000,...(cursor?{ContinuationToken:cursor}:{})}),signal);
        const rows=page.Contents??[];
        if(page.KeyCount!==rows.length||rows.length>1000||page.CommonPrefixes?.length||typeof page.IsTruncated!=='boolean')fail();
        for(const row of rows){if(!expected.has(row.Key)||seen.has(row.Key))fail();seen.add(row.Key);}
        if(!page.IsTruncated){if(seen.size!==expected.size)fail();await isolated(signal);await ownership(signal);return;}
        cursor=page.NextContinuationToken;if(typeof cursor!=='string'||!cursor||cursors.has(cursor))fail();cursors.add(cursor);
      }
      fail();
      });
    },
    close(){state='CLOSED';reader.close();client.destroy();},
  };
}
