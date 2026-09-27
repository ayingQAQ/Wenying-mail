import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {d1Api} from './d1-api.mjs';

// SQL is already prepared/validated by the restore target. MD5 is the D1 upload
// protocol checksum, not the integrity mechanism used for encrypted backups.
export async function importD1({sql,uploadOrigins,signal,fetcher=fetch,maxPolls=600,pollMs=1000,wait=ms=>delay(ms,undefined,{signal}),...credentials}) {
  if(!Buffer.isBuffer(sql)||!sql.length||sql.length>512*1024*1024||!signal||
    !Array.isArray(uploadOrigins)||!uploadOrigins.length||!Number.isSafeInteger(maxPolls)||maxPolls<1||maxPolls>3600||
    !Number.isSafeInteger(pollMs)||pollMs<1||pollMs>5000)throw Error('INVALID_D1_IMPORT_CONFIG');
  const allowed=new Set(uploadOrigins.map(origin=>{const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw Error('INVALID_D1_IMPORT_ORIGIN');return origin;}));
  const api=d1Api({...credentials,fetcher,maxResponseBytes:1024*1024}),etag=createHash('md5').update(sql).digest('hex');
  let upload;
  try {
    let result=await api('/import',{body:{action:'init',etag},signal});
    if(result.upload_url!==undefined) {
      const url=new URL(result.upload_url);
      if(url.protocol!=='https:'||!allowed.has(url.origin)||url.username||url.password||url.hash||
        typeof result.filename!=='string'||!result.filename||result.filename.length>2048)throw Error('D1_IMPORT_UPLOAD_REJECTED');
      signal.throwIfAborted();
      // No Cloudflare token or cookies on the presigned object-store upload.
      upload=await fetcher(url,{method:'PUT',body:sql,redirect:'error',signal,headers:{'Content-Length':String(sql.length)}});
      if(upload.status!==200||upload.redirected||upload.headers.get('etag')?.replace(/^"|"$/g,'')!==etag)throw Error('D1_IMPORT_UPLOAD_FAILED');
      await upload.body?.cancel();upload=null;
      result=await api('/import',{body:{action:'ingest',etag,filename:result.filename},signal});
    }
    let bookmark;
    for(let poll=0;poll<maxPolls;poll++) {
      signal.throwIfAborted();
      if(result.success!==true||result.status==='error')throw Error('D1_IMPORT_FAILED');
      if(typeof result.at_bookmark!=='string'||!result.at_bookmark||result.at_bookmark.length>1024||bookmark&&bookmark!==result.at_bookmark)throw Error('D1_IMPORT_BOOKMARK_CHANGED');
      bookmark=result.at_bookmark;
      if(result.status==='complete') {
        const finalBookmark=result.result?.final_bookmark;
        if(typeof finalBookmark!=='string'||!finalBookmark||finalBookmark.length>1024)throw Error('D1_IMPORT_FAILED');
        return {bookmark,finalBookmark};
      }
      if(result.status!==undefined)throw Error('D1_IMPORT_FAILED');
      if(poll+1>=maxPolls)throw Error('D1_IMPORT_TIMEOUT');
      await wait(pollMs);
      result=await api('/import',{body:{action:'poll',current_bookmark:bookmark},signal});
    }
  }catch(error){
    const safe=['D1_IMPORT_UPLOAD_REJECTED','D1_IMPORT_UPLOAD_FAILED','D1_IMPORT_BOOKMARK_CHANGED','D1_IMPORT_TIMEOUT'];
    throw Error(signal.aborted?'D1_IMPORT_ABORTED':safe.includes(error.message)?error.message:'D1_IMPORT_FAILED');
  }finally{await upload?.body?.cancel().catch(()=>{});}
}
