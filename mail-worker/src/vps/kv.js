import {transportSignal} from './work-budget.js';
const fail=()=>new Error('KV_REMOTE_UNAVAILABLE');
export function remoteKV({accountId,namespaceId,token,fetcher=fetch}){
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-f0-9]{32}$/.test(namespaceId)||!token||/\s/.test(token))throw new Error('INVALID_KV_CONFIG');
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
  function keyPath(key){if(typeof key!=='string'||!key||Buffer.byteLength(key)>512||key==='.'||key==='..')throw fail();return encodeURIComponent(key);}
  async function call(path,{method='GET',body,headers={},missing=false,json=false}={}){
    try{
      const response=await fetcher(base+path,{method,body,headers:{...headers,Authorization:`Bearer ${token}`},redirect:'error',signal:transportSignal(30000)});
      if(missing&&response.status===404){await response.body?.cancel();return null;}
      if(!response.ok){await response.body?.cancel();throw fail();}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>25*1024*1024)throw fail();chunks.push(item.value);}}
      catch{await reader.cancel().catch(()=>{});throw fail();}finally{reader.releaseLock();}
      const bytes=Buffer.concat(chunks);if(!json)return bytes;
      const value=JSON.parse(bytes.toString('utf8'));if(value.success!==true)throw fail();return value;
    }catch{throw fail();}
  }
  const binding={
    async get(key,options={}){
      const type=typeof options==='string'?options:options.type??'text';if(!['text','json','arrayBuffer'].includes(type))throw fail();
      const bytes=await call(`/values/${keyPath(key)}`,{missing:true});if(bytes===null)return null;
      if(type==='arrayBuffer')return Uint8Array.from(bytes).buffer;
      const text=bytes.toString('utf8');return type==='json'?JSON.parse(text):text;
    },
    async getWithMetadata(key,options){
      const value=await binding.get(key,options);if(value===null)return {value:null,metadata:null};
      const metadata=await call(`/metadata/${keyPath(key)}`,{missing:true,json:true});
      return {value,metadata:metadata?.result??null};
    },
    async put(key,value,options={}){
      const bytes=typeof value==='string'?Buffer.from(value):value instanceof ArrayBuffer?Buffer.from(value):ArrayBuffer.isView(value)?Buffer.from(value.buffer,value.byteOffset,value.byteLength):null;
      if(!bytes||bytes.length>25*1024*1024||Object.keys(options).some(k=>k!=='metadata'))throw fail();
      const form=new FormData();form.set('value',new Blob([bytes]));if(options.metadata!==undefined)form.set('metadata',JSON.stringify(options.metadata));
      await call(`/values/${keyPath(key)}`,{method:'PUT',body:form,json:true});
    },
    async delete(key){await call(`/values/${keyPath(key)}`,{method:'DELETE',json:true});},
    async list({prefix='',cursor,limit=1000}={}){
      if(!Number.isInteger(limit)||limit<1||limit>1000)throw fail();
      const params=new URLSearchParams({prefix,limit:String(limit)});if(cursor)params.set('cursor',cursor);
      const result=await call(`/keys?${params}`,{json:true});if(!Array.isArray(result.result))throw fail();
      return {keys:result.result,cursor:result.result_info?.cursor,list_complete:!result.result_info?.cursor};
    },
  };return binding;
}
