import {setTimeout as delay} from 'node:timers/promises';

// Deliberately no CLI or implicit environment lookup: the complete runner must
// acquire a backup hold and receive an explicit authorized target first.
export async function exportD1({accountId,databaseId,token,downloadOrigins,signal,fetcher=fetch,pollMs=1000,maxPolls=600,
  wait=ms=>delay(ms,undefined,{signal})}) {
  if(!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9-]{36}$/.test(databaseId) || typeof token!=='string' || !token ||
    !signal || !Array.isArray(downloadOrigins) || !downloadOrigins.length ||
    !Number.isSafeInteger(maxPolls) || maxPolls<1 || maxPolls>3600 || !Number.isSafeInteger(pollMs) || pollMs<1 || pollMs>5000)
    throw new Error('INVALID_D1_EXPORT_CONFIG');
  const allowed=new Set(downloadOrigins.map(origin=>{
    const url=new URL(origin);if(url.protocol!=='https:' || url.origin!==origin) throw new Error('INVALID_D1_EXPORT_ORIGIN');return origin;
  }));
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
  let bookmark;const startedAt=Date.now();
  try {
    for(let poll=0;poll<maxPolls;poll++) {
      signal.throwIfAborted();
      const response=await fetcher(endpoint,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({output_format:'polling',...(bookmark?{current_bookmark:bookmark}:{})})});
      if(!response.ok) throw new Error('D1_EXPORT_FAILED');
      const data=await response.json(),result=data?.result;
      if(data.success!==true || !result || result.status==='error' || result.success===false) throw new Error('D1_EXPORT_FAILED');
      if(typeof result.at_bookmark!=='string' || !result.at_bookmark || result.at_bookmark.length>1024 || (bookmark && bookmark!==result.at_bookmark))
        throw new Error('D1_EXPORT_BOOKMARK_CHANGED');
      bookmark=result.at_bookmark;
      if(result.status==='complete') {
        const url=new URL(result.result?.signed_url);
        if(url.protocol!=='https:' || !allowed.has(url.origin) || url.username || url.password || url.hash) throw new Error('D1_EXPORT_DOWNLOAD_REJECTED');
        // Never forward the account API token to the temporary download URL.
        const download=await fetcher(url,{method:'GET',redirect:'error',signal});
        if(!download.ok || !download.body) throw new Error('D1_EXPORT_DOWNLOAD_FAILED');
        return {bookmark,startedAt,completedAt:Date.now(),body:download.body};
      }
      if(result.status!==undefined) throw new Error('D1_EXPORT_FAILED');
      if(poll+1<maxPolls) await wait(pollMs);
    }
    throw new Error('D1_EXPORT_TIMEOUT');
  } catch(error) {
    // Neither account credentials, signed URLs nor vendor messages escape.
    const safe=['D1_EXPORT_FAILED','D1_EXPORT_BOOKMARK_CHANGED','D1_EXPORT_DOWNLOAD_REJECTED','D1_EXPORT_DOWNLOAD_FAILED','D1_EXPORT_TIMEOUT'];
    throw new Error(signal.aborted?'D1_EXPORT_ABORTED':safe.includes(error.message)?error.message:'D1_EXPORT_FAILED');
  }
}
