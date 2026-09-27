import {createRequire} from 'node:module';
import {metadataNamesMap} from './metadata-names.mjs';
import {validateS3Target} from './s3-config.mjs';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {S3Client,HeadObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const canonical=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
const fail=()=>{throw new Error('LEGACY_S3_READ_FAILED');};

export function s3Source({target,accessKeyId,secretAccessKey,requestHandler}) {
  validateS3Target(target);
  if([accessKeyId,secretAccessKey].some(value=>typeof value!=='string'||!value||/[\r\n\x00]/.test(value)))throw new Error('INVALID_S3_SOURCE_CONFIG');
  const names=metadataNamesMap(target.metadataNames??{}),bodies=new Set();let closed=false;
  const client=new S3Client({endpoint:target.endpoint,region:target.region,forcePathStyle:target.forcePathStyle,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId,secretAccessKey},...(requestHandler?{requestHandler}:{}),
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  function describe(object) {
    const uploadedAt=object.LastModified?.getTime(),version=object.VersionId;
    if(object.DeleteMarker||object.MissingMeta>0||!Number.isSafeInteger(object.ContentLength)||object.ContentLength<0||object.ContentLength>25*1024*1024||
      !Number.isSafeInteger(uploadedAt)||uploadedAt<0||typeof object.ETag!=='string'||!object.ETag||object.ETag.length>1024||
      (version!==undefined&&(typeof version!=='string'||!version||version.length>1024)))fail();
    const customMetadata=Object.create(null),httpMetadata={};
    for(const [key,value] of Object.entries(object.Metadata??{})) {
      const name=names.get(key.toLowerCase());if(!name||typeof value!=='string'||Object.hasOwn(customMetadata,name))fail();customMetadata[name]=value;
    }
    for(const [key,name] of Object.entries({ContentType:'contentType',ContentLanguage:'contentLanguage',ContentDisposition:'contentDisposition',ContentEncoding:'contentEncoding',CacheControl:'cacheControl'})) {
      if(object[key]!==undefined){if(typeof object[key]!=='string')fail();httpMetadata[name]=object[key];}
    }
    if(object.Expires!==undefined){if(!(object.Expires instanceof Date)||!Number.isFinite(object.Expires.getTime()))fail();httpMetadata.cacheExpiry=object.Expires.toISOString();}
    return {size:object.ContentLength,uploadedAt,etag:object.ETag,version,customMetadata,httpMetadata};
  }
  async function send(command,signal) {if(closed||!signal)fail();signal.throwIfAborted();return client.send(command,{abortSignal:signal});}
  return {
    async readObject(backend,key,signal) {
      if(backend!=='s3'||typeof key!=='string'||!/^attachments\/[A-Za-z0-9_.-]+$/.test(key)||key.length>512||['.','..'].includes(key.slice(12)))
        throw new Error('LEGACY_S3_REFERENCE_REJECTED');
      let object;
      const cancel=()=>{object?.Body?.destroy?.();bodies.delete(object?.Body);};
      try {
        const reference={Bucket:target.bucket,Key:key};
        const expected=describe(await send(new HeadObjectCommand(reference),signal));
        object=await send(new GetObjectCommand({...reference,IfMatch:expected.etag,...(expected.version!==undefined?{VersionId:expected.version}:{})}),signal);
        bodies.add(object.Body);const actual=describe(object);
        if(actual.size!==expected.size||actual.uploadedAt!==expected.uploadedAt||actual.etag!==expected.etag||actual.version!==expected.version||
          canonical(actual.customMetadata)!==canonical(expected.customMetadata)||canonical(actual.httpMetadata)!==canonical(expected.httpMetadata)||!object.Body?.[Symbol.asyncIterator])fail();
        const body=(async function*(){let size=0;try {
          for await(const chunk of object.Body){signal.throwIfAborted();const bytes=Buffer.from(chunk);size+=bytes.length;if(size>expected.size)fail();yield bytes;}
          if(size!==expected.size)fail();
        }catch {throw new Error(signal.aborted?'LEGACY_S3_ABORTED':'LEGACY_S3_READ_FAILED');}finally{cancel();}})();
        return {size:expected.size,uploadedAt:expected.uploadedAt,customMetadata:expected.customMetadata,httpMetadata:expected.httpMetadata,body,cancel};
      }catch {cancel();throw new Error(signal?.aborted?'LEGACY_S3_ABORTED':'LEGACY_S3_READ_FAILED');}
    },
    close(){closed=true;for(const body of bodies)body?.destroy?.();bodies.clear();client.destroy();},
  };
}
