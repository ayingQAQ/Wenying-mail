import {S3Client,GetObjectCommand,HeadObjectCommand,PutObjectCommand,ListObjectsV2Command,DeleteObjectsCommand} from '@aws-sdk/client-s3';
import {transportSignal} from './work-budget.js';
const fail=()=>new Error('R2_REMOTE_UNAVAILABLE');
const names=new Map(['schemaVersion','deliveryId','userId','accountId','envelopeFrom','envelopeTo','receivedAt','rawSize','generation'].map(name=>[name.toLowerCase(),name]));
const fields={ContentType:'contentType',ContentLanguage:'contentLanguage',ContentDisposition:'contentDisposition',ContentEncoding:'contentEncoding',CacheControl:'cacheControl'};
function keyValid(key){if(typeof key!=='string'||!key||Buffer.byteLength(key)>1024||/[\x00-\x1f\x7f]/.test(key)||key.split('/').some(p=>p==='.'||p==='..'))throw fail();return key;}
export function remoteR2({accountId,bucket,accessKeyId,secretAccessKey,requestHandler}){
  if(!/^[a-f0-9]{32}$/.test(accountId)||! /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||!accessKeyId||!secretAccessKey)throw new Error('INVALID_R2_CONFIG');
  const client=new S3Client({endpoint:`https://${accountId}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId,secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',...(requestHandler?{requestHandler}:{})});
  const send=command=>client.send(command,{abortSignal:transportSignal(120000)});
  function describe(key,value){
    if(!Number.isSafeInteger(value.ContentLength)||value.ContentLength<0||value.ContentLength>25*1024*1024||value.MissingMeta>0||
      !(value.LastModified instanceof Date)||!Number.isFinite(value.LastModified.getTime())||typeof value.ETag!=='string')throw fail();
    const customMetadata=Object.create(null),httpMetadata={},checksums={};
    for(const [name,content] of Object.entries(value.Metadata??{})){if(typeof content!=='string')throw fail();customMetadata[names.get(name.toLowerCase())??name]=content;}
    for(const [source,target] of Object.entries(fields))if(value[source]!==undefined)httpMetadata[target]=value[source];
    if(value.ChecksumSHA256!==undefined){
      const encoded=value.ChecksumSHA256,bytes=Buffer.from(encoded,'base64');
      if(bytes.length!==32||bytes.toString('base64')!==encoded||value.ChecksumType!==undefined&&value.ChecksumType!=='FULL_OBJECT')throw fail();
      checksums.sha256=Uint8Array.from(bytes).buffer;
    }
    return {key,size:value.ContentLength,uploaded:value.LastModified,etag:value.ETag.replace(/^"|"$/g,''),httpEtag:value.ETag,customMetadata,httpMetadata,checksums};
  }
  async function read(key,head){
    keyValid(key);let value;
    try{
      value=await send(new (head?HeadObjectCommand:GetObjectCommand)({Bucket:bucket,Key:key,ChecksumMode:'ENABLED'}));
      const result=describe(key,value);if(head)return result;
      if(!value.Body?.transformToWebStream)throw fail();
      const body=value.Body.transformToWebStream();
      return {...result,body,arrayBuffer:()=>new Response(body).arrayBuffer(),text:()=>new Response(body).text(),json:()=>new Response(body).json()};
    }catch(error){value?.Body?.destroy?.();if(error.$metadata?.httpStatusCode===404)return null;throw fail();}
  }
  const binding={get:key=>read(key,false),head:key=>read(key,true),
    async put(key,data,options={}){
      keyValid(key);
      if(Object.keys(options).some(name=>!['onlyIf','sha256','customMetadata','httpMetadata'].includes(name)))throw fail();
      if(options.onlyIf&&Object.keys(options.onlyIf).join(',')!=='etagDoesNotMatch'||options.onlyIf&&options.onlyIf.etagDoesNotMatch!=='*')throw fail();
      const body=typeof data==='string'?Buffer.from(data):data instanceof ArrayBuffer?Buffer.from(data):ArrayBuffer.isView(data)?Buffer.from(data.buffer,data.byteOffset,data.byteLength):null;
      if(!body||body.length>25*1024*1024)throw fail();
      const extra={};for(const [source,target] of Object.entries(fields))if(options.httpMetadata?.[target]!==undefined)extra[source]=options.httpMetadata[target];
      if(options.sha256){const checksum=Buffer.from(options.sha256);if(checksum.length!==32)throw fail();extra.ChecksumSHA256=checksum.toString('base64');}
      try{
        await send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentLength:body.length,Metadata:options.customMetadata,
          ...extra,...(options.onlyIf?{IfNoneMatch:'*'}:{})}));
        const stored=await binding.head(key);if(!stored)throw fail();return stored;
      }catch(error){if(options.onlyIf&&error.$metadata?.httpStatusCode===412)return null;throw fail();}
    },
    async list({prefix='',cursor,limit=1000,delimiter,include=[]}={}){
      if(typeof prefix!=='string'||Buffer.byteLength(prefix)>1024||!Number.isInteger(limit)||limit<1||limit>1000||delimiter!==undefined&&delimiter!=='/'||include.some(v=>!['customMetadata','httpMetadata'].includes(v)))throw fail();
      try{
        const page=await send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:limit,ContinuationToken:cursor,Delimiter:delimiter}));
        if(typeof page.IsTruncated!=='boolean'||page.IsTruncated&&!page.NextContinuationToken||(page.Contents?.length??0)+(page.CommonPrefixes?.length??0)>limit)throw fail();
        const objects=[];
        for(const row of page.Contents??[]){
          keyValid(row.Key);if(!row.Key.startsWith(prefix)||!Number.isSafeInteger(row.Size)||row.Size<0||!(row.LastModified instanceof Date))throw fail();
          if(include.length){const details=await binding.head(row.Key);if(!details||details.size!==row.Size||details.httpEtag!==row.ETag)throw fail();objects.push(details);}
          else objects.push({key:row.Key,size:row.Size,uploaded:row.LastModified,etag:row.ETag?.replace(/^"|"$/g,''),httpEtag:row.ETag});
        }
        const delimitedPrefixes=(page.CommonPrefixes??[]).map(row=>{if(typeof row.Prefix!=='string'||!row.Prefix.startsWith(prefix))throw fail();return row.Prefix;});
        return {objects,truncated:page.IsTruncated,cursor:page.NextContinuationToken,delimitedPrefixes};
      }catch{throw fail();}
    },
    async delete(keys){
      const list=Array.isArray(keys)?keys:[keys];if(!list.length||list.length>1000)throw fail();list.forEach(keyValid);
      try{const result=await send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:list.map(Key=>({Key})),Quiet:true}}));if(result.Errors?.length)throw fail();}
      catch{throw fail();}
    },
    close:()=>client.destroy(),
  };return binding;
}
