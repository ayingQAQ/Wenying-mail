import {transportSignal} from './work-budget.js';
const fail=()=>new Error('CLOUDFLARE_API_UNAVAILABLE');
export function cloudApi({accountId,token,fetcher=fetch,timeoutMs=30000}){
  if(!/^[a-f0-9]{32}$/.test(accountId)||typeof token!=='string'||!token||/[\s\x00]/.test(token))throw new Error('INVALID_CLOUDFLARE_CONFIG');
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  return async function request(path,{body,method=body===undefined?'GET':'POST',signal}={}){
    if(typeof path!=='string'||!/^\/(d1|queues|storage)\//.test(path)||path.includes('..')||path.includes('#'))throw fail();
    try{
      const response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),redirect:'error',
        signal:transportSignal(timeoutMs,signal)});
      if(!response.ok){await response.body?.cancel();throw fail();}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32*1024*1024)throw fail();chunks.push(part.value);}}
      catch{await reader.cancel().catch(()=>{});throw fail();}finally{reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(value.success!==true)throw fail();return value.result;
    }catch{throw fail();}
  };
}
