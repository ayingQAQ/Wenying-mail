import {createHash} from 'node:crypto';
const limit=25*1024*1024;
const fail=()=>{throw new Error('LEGACY_KV_READ_FAILED');};
const canonical=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));

// Historical flat attachments only. No namespace listing, configuration reads,
// writes, or backend discovery. uploadedAt=0 means the KV API has no upload time.
export function kvSource({accountId,namespaceId,token,fetcher=fetch}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||! /^[a-f0-9]{32}$/.test(namespaceId)||typeof token!=='string'||!token||/[\r\n\x00]/.test(token))
    throw new Error('INVALID_KV_SOURCE_CONFIG');
  let closed=false;
  async function read(path,key,signal,maxBytes,retain=true) {
    if(closed||!signal)fail();signal.throwIfAborted();
    const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/${path}/${encodeURIComponent(key)}`,
      {method:'GET',redirect:'error',signal,headers:{Authorization:`Bearer ${token}`}});
    const reader=response.body?.getReader();
    try {
      if(!response.ok||response.redirected||!reader||response.headers.has('expiration'))fail();
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>maxBytes))fail();
      let size=0;const chunks=[],hash=createHash('sha256');
      for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>maxBytes)fail();hash.update(value);if(retain)chunks.push(Buffer.from(value));}
      if(length!==null&&Number(length)!==size)fail();
      return {size,sha256:hash.digest('hex'),bytes:retain?Buffer.concat(chunks):undefined};
    } finally {await reader?.cancel().catch(()=>{});reader?.releaseLock();}
  }
  async function metadata(key,signal) {
    const data=JSON.parse((await read('metadata',key,signal,65536)).bytes.toString('utf8'));
    if(data.success!==true||!Object.hasOwn(data,'result'))fail();
    const value=data.result??{};
    if(typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,item])=>key.length>1024||typeof item!=='string'||item.length>16384))fail();
    return value;
  }
  return {
    async readObject(backend,key,signal) {
      if(backend!=='kv'||typeof key!=='string'||!/^attachments\/[A-Za-z0-9_.-]+$/.test(key)||key.length>512||['.','..'].includes(key.slice(12)))
        throw new Error('LEGACY_KV_REFERENCE_REJECTED');
      try {
        const before=await metadata(key,signal),value=await read('values',key,signal,limit);
        const repeated=await read('values',key,signal,limit,false),after=await metadata(key,signal);
        if(canonical(before)!==canonical(after)||value.size!==repeated.size||value.sha256!==repeated.sha256)fail();
        return {size:value.size,sha256:value.sha256,uploadedAt:0,customMetadata:before,httpMetadata:{},body:[value.bytes]};
      } catch {throw new Error(signal?.aborted?'LEGACY_KV_ABORTED':'LEGACY_KV_READ_FAILED');}
    },
    close(){closed=true;},
  };
}
