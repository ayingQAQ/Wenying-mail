// All authenticated traffic stays on the fixed Cloudflare API origin.
export function d1Api({accountId,databaseId,token,fetcher=fetch,maxResponseBytes=8*1024*1024}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId)||
    typeof token!=='string'||!token||token.length>4096||/[\s\x00]/.test(token)||
    !Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1024||maxResponseBytes>64*1024*1024)throw Error('INVALID_D1_API_CONFIG');
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
  return async function request(path,{body,signal}={}) {
    if(!['','/query','/import','/time_travel/bookmark'].includes(path)||!signal)throw Error('INVALID_D1_API_REQUEST');
    let response;
    try {
      signal.throwIfAborted();
      response=await fetcher(endpoint+path,{method:body===undefined?'GET':'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(response.status===413)throw Error('D1_RESPONSE_LIMIT');
      if(!response.ok||response.redirected||!response.body)throw Error('D1_API_FAILED');
      let size=0;const chunks=[];
      for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>maxResponseBytes)throw Error('D1_RESPONSE_LIMIT');chunks.push(Buffer.from(chunk));}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(data.success!==true||!Array.isArray(data.errors)||data.errors.length||data.result===undefined)throw Error('D1_API_FAILED');
      return data.result;
    }catch(error){throw Error(signal.aborted?'D1_API_ABORTED':error.message==='D1_RESPONSE_LIMIT'?'D1_RESPONSE_LIMIT':'D1_API_FAILED');}
    finally{await response?.body?.cancel().catch(()=>{});}
  };
}
