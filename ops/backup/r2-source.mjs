import {createRequire} from 'node:module';
import {metadataNamesMap} from './metadata-names.mjs';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {S3Client,ListObjectsV2Command,HeadObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const canonical=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const timestamp=value=>value instanceof Date&&integer(value.getTime())?value.getTime():null;
const keyValid=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f]/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
const fail=code=>{throw new Error(code);};

// Only reads the explicitly named global-jurisdiction R2 bucket. Credentials
// never fall back to AWS environment/profile discovery. No writes/deletes.
export function r2Source({accountId,bucket,accessKeyId,secretAccessKey,metadataNames={},maxPages=10000,maxObjects=1000000,requestHandler,requireSha256=false}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/[a-z0-9]/.test(bucket??'')||!/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.test(bucket??'')||
    typeof accessKeyId!=='string'||!accessKeyId||typeof secretAccessKey!=='string'||!secretAccessKey||
    !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10000||!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1000000)
    fail('INVALID_R2_SOURCE_CONFIG');
  const names=metadataNamesMap(metadataNames);
  const client=new S3Client({region:'auto',endpoint:`https://${accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,
    followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId,secretAccessKey},...(requestHandler?{requestHandler}:{}),
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const observed=new Map(),bodies=new Set();let closed=false;
  async function send(command,signal) {
    if(closed||!signal)fail('R2_SOURCE_UNAVAILABLE');signal.throwIfAborted();
    try{return await client.send(command,{abortSignal:signal});}
    catch {fail(signal.aborted?'R2_SOURCE_ABORTED':'R2_SOURCE_READ_FAILED');}
  }
  function remember(key,description) {
    const previous=observed.get(key);
    if(previous&&(previous.etag!==description.etag||previous.size!==description.size||previous.uploadedAt!==description.uploadedAt))fail('R2_OBJECT_CHANGED');
    if(!previous&&observed.size>=maxObjects)fail('R2_INVENTORY_LIMIT');observed.set(key,description);
  }
  function descriptor(object,size=object.ContentLength) {
    const uploadedAt=timestamp(object.LastModified);
    if(!integer(size)||size>25*1024*1024||uploadedAt===null||typeof object.ETag!=='string'||!object.ETag||object.ETag.length>1024)fail('R2_OBJECT_INVALID');
    // S3 Last-Modified response headers have second resolution; LIST may be finer.
    return {size,uploadedAt:Math.floor(uploadedAt/1000)*1000,etag:object.ETag};
  }
  function metadata(object) {
    if(object.MissingMeta>0)fail('R2_METADATA_INCOMPLETE');
    const customMetadata=Object.create(null),httpMetadata={};
    for(const [key,value] of Object.entries(object.Metadata??{})) {
      const name=names.get(key.toLowerCase());
      // S3 response headers lose original key case. Never guess unknown keys.
      if(!name)fail('R2_METADATA_MAPPING_REQUIRED');
      if(typeof value!=='string'||Object.hasOwn(customMetadata,name))fail('R2_METADATA_INVALID');customMetadata[name]=value;
    }
    for(const [source,target] of Object.entries({ContentType:'contentType',ContentLanguage:'contentLanguage',ContentDisposition:'contentDisposition',ContentEncoding:'contentEncoding',CacheControl:'cacheControl'})) {
      if(object[source]!==undefined){if(typeof object[source]!=='string')fail('R2_METADATA_INVALID');httpMetadata[target]=object[source];}
    }
    if(object.Expires!==undefined){if(timestamp(object.Expires)===null)fail('R2_METADATA_INVALID');httpMetadata.cacheExpiry=object.Expires.toISOString();}
    return {customMetadata,httpMetadata};
  }
  function storedChecksum(object){
    if(!requireSha256)return undefined;
    const encoded=object.ChecksumSHA256;
    if(typeof encoded!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(encoded)||
      Buffer.from(encoded,'base64').toString('base64')!==encoded||
      (object.ChecksumType!==undefined&&object.ChecksumType!=='FULL_OBJECT'))fail('R2_STORED_SHA256_MISSING');
    return Buffer.from(encoded,'base64').toString('hex');
  }
  return {
    async *inventory(snapshotAt,signal,prefixes=['raw/','tombstones/']) {
      if(!integer(snapshotAt))fail('INVALID_SNAPSHOT_TIME');
      if(!Array.isArray(prefixes)||!prefixes.length||new Set(prefixes).size!==prefixes.length||prefixes.some(prefix=>!['raw/','tombstones/'].includes(prefix)))fail('INVALID_INVENTORY_PREFIX');
      for(const prefix of prefixes) {
        let cursor,previousKey;const cursors=new Set();let complete=false;
        for(let page=0;page<maxPages;page++) {
          const result=await send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:1000,...(cursor?{ContinuationToken:cursor}:{})}),signal);
          const rows=result.Contents??[];
          if(!Array.isArray(rows)||rows.length>1000||typeof result.IsTruncated!=='boolean'||result.KeyCount!==rows.length||
            (result.Name!==undefined&&result.Name!==bucket)||(result.Prefix!==undefined&&result.Prefix!==prefix)||(result.CommonPrefixes?.length))fail('R2_INVENTORY_INVALID');
          for(const row of rows) {
            if(!keyValid(row.Key)||!row.Key.startsWith(prefix)||(previousKey&&Buffer.compare(Buffer.from(previousKey),Buffer.from(row.Key))>=0))fail('R2_INVENTORY_INVALID');
            previousKey=row.Key;const details=descriptor(row,row.Size);remember(row.Key,details);
            // Collector applies T, while retaining T-later objects needed by SQL.
            yield {backend:'r2',key:row.Key,uploadedAt:details.uploadedAt};
          }
          if(!result.IsTruncated){complete=true;break;}
          const next=result.NextContinuationToken;
          if(typeof next!=='string'||!next||next.length>16384||cursors.has(next))fail('R2_INVENTORY_INVALID');
          cursors.add(next);cursor=next;
        }
        if(!complete)fail('R2_INVENTORY_LIMIT');
      }
    },
    async readObject(backend,key,signal) {
      if(backend!=='r2'||!keyValid(key))fail('R2_SOURCE_REFERENCE_REJECTED');
      const checksumOptions=requireSha256?{ChecksumMode:'ENABLED'}:{};
      const head=await send(new HeadObjectCommand({Bucket:bucket,Key:key,...checksumOptions}),signal),expected=descriptor(head),headers=metadata(head),sha256=storedChecksum(head);
      remember(key,expected);
      const object=await send(new GetObjectCommand({Bucket:bucket,Key:key,IfMatch:expected.etag,...checksumOptions}),signal);
      const cancel=()=>{object.Body?.destroy?.();bodies.delete(object.Body);};bodies.add(object.Body);
      try {
        const actual=descriptor(object),actualHeaders=metadata(object);
        remember(key,actual);
        if(storedChecksum(object)!==sha256||canonical(headers.customMetadata)!==canonical(actualHeaders.customMetadata)||canonical(headers.httpMetadata)!==canonical(actualHeaders.httpMetadata)||!object.Body?.[Symbol.asyncIterator])fail('R2_OBJECT_CHANGED');
      } catch(error){cancel();throw error;}
      const body=(async function*(){let size=0;try {
        for await(const chunk of object.Body){signal.throwIfAborted();const bytes=Buffer.from(chunk);size+=bytes.length;if(size>expected.size)fail('R2_OBJECT_LENGTH_MISMATCH');yield bytes;}
        if(size!==expected.size)fail('R2_OBJECT_LENGTH_MISMATCH');
      }catch {fail(signal.aborted?'R2_SOURCE_ABORTED':'R2_OBJECT_STREAM_FAILED');}finally{cancel();}})();
      // ETag is a conditional-read identity, never treated as a SHA-256 hash.
      return {size:expected.size,uploadedAt:expected.uploadedAt,...headers,...(requireSha256?{sha256}:{}),body,cancel};
    },
    close(){closed=true;for(const body of bodies)body?.destroy?.();bodies.clear();client.destroy();observed.clear();},
  };
}
