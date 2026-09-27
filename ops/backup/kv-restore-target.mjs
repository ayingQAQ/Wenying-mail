import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const markerKey='.mail-restore/reservation.json',maxValue=25*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
const safeErrors=new Set(['KV_RESTORE_STATE_INVALID','KV_RESTORE_NOT_VISIBLE','KV_RESTORE_API_FAILED','KV_RESTORE_EXPIRING_VALUE',
  'KV_RESTORE_RESPONSE_LIMIT','KV_RESTORE_RESPONSE_INVALID','KV_RESTORE_TARGET_MISMATCH','KV_RESTORE_METADATA_INVALID',
  'KV_RESTORE_OWNERSHIP_LOST','KV_RESTORE_INVENTORY_INVALID','KV_RESTORE_INVENTORY_MISMATCH','KV_RESTORE_INVENTORY_LIMIT',
  'KV_RESTORE_OBJECT_INVALID','KV_RESTORE_DATA_MISMATCH']);
const validMetadata=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.values(value).every(item=>typeof item==='string')&&Buffer.byteLength(JSON.stringify(value))<=1024;

// KV has no conditional create for values. This target therefore never accepts
// an existing namespace: it creates a new, unbound namespace and writes each key
// once. The caller must durably journal intent/identity and keep other writers out.
export function kvRestoreObjects({accountId,sourceNamespaceId,token,environment,record,signal,fetcher=fetch,
  maxObjects=1000000,visibilityAttempts=25,visibilityDelayMs=5000,wait=ms=>delay(ms,undefined,{signal:runSignal})}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-f0-9]{32}$/.test(sourceNamespaceId)||
    typeof token!=='string'||!token||token.length>4096||/[\s\x00]/.test(token)||!['staging','production'].includes(environment)||
    typeof record!=='function'||!signal||!Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1000000||
    !Number.isSafeInteger(visibilityAttempts)||visibilityAttempts<1||visibilityAttempts>61||
    !Number.isSafeInteger(visibilityDelayMs)||visibilityDelayMs<1||visibilityDelayMs>10000)fail('INVALID_KV_RESTORE_CONFIG');
  const stop=new AbortController(),runSignal=AbortSignal.any([signal,stop.signal]),owner=randomUUID();
  const title=`cloud-mail-${environment}-restore-${owner}`,marker=Buffer.from(JSON.stringify({version:1,owner}));
  const root=`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
  let state='NEW',namespaceId;const written=new Map();
  const step=expected=>{runSignal.throwIfAborted();if(state!==expected)fail('KV_RESTORE_STATE_INVALID');};
  const failure=error=>{state='FAILED';throw Error(runSignal.aborted?'KV_RESTORE_ABORTED':safeErrors.has(error?.message)?error.message:'KV_RESTORE_FAILED');};
  async function request(path,{method='GET',body,jsonBody,raw=false,retain=true,limit=2*1024*1024}={}) {
    runSignal.throwIfAborted();let response;
    try {
      response=await fetcher(root+path,{method,signal:runSignal,redirect:'error',headers:{Authorization:'Bearer '+token,
        ...(jsonBody===undefined?{}:{'Content-Type':'application/json'})},body:jsonBody===undefined?body:JSON.stringify(jsonBody)});
      if(method==='GET'&&response.status===404)fail('KV_RESTORE_NOT_VISIBLE');
      if(!response.ok||response.redirected)fail('KV_RESTORE_API_FAILED');
      if(response.headers.has('expiration'))fail('KV_RESTORE_EXPIRING_VALUE');
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>limit))fail('KV_RESTORE_RESPONSE_LIMIT');
      let size=0;const chunks=[],hash=createHash('sha256');
      if(response.body)for await(const chunk of response.body){runSignal.throwIfAborted();size+=chunk.length;if(size>limit)fail('KV_RESTORE_RESPONSE_LIMIT');hash.update(chunk);if(retain)chunks.push(Buffer.from(chunk));}
      if(length!==null&&Number(length)!==size)fail('KV_RESTORE_RESPONSE_INVALID');
      const bytes=retain?Buffer.concat(chunks):undefined;
      if(raw)return {size,sha256:hash.digest('hex'),bytes};
      const value=JSON.parse(bytes.toString('utf8'));
      if(value.success!==true||!Array.isArray(value.errors)||value.errors.length)fail('KV_RESTORE_API_FAILED');
      return value;
    }finally{await response?.body?.cancel().catch(()=>{});}
  }
  async function visible(action) {
    for(let attempt=0;attempt<visibilityAttempts;attempt++){
      try{return await action();}catch(error){
        if(error.message!=='KV_RESTORE_NOT_VISIBLE'||attempt+1===visibilityAttempts)throw error;
        await wait(visibilityDelayMs);runSignal.throwIfAborted();
      }
    }
  }
  async function identity(){const {result}=await request('/'+namespaceId);if(result?.id!==namespaceId||result?.title!==title)fail('KV_RESTORE_TARGET_MISMATCH');}
  async function metadata(key) {
    const {result}=await request(`/${namespaceId}/metadata/${encodeURIComponent(key)}`,{limit:65536});
    const value=result??{};if(!validMetadata(value))fail('KV_RESTORE_METADATA_INVALID');return value;
  }
  async function ownership() {
    if(!isDeepStrictEqual(await metadata(markerKey),{}))fail('KV_RESTORE_OWNERSHIP_LOST');
    const value=await request(`/${namespaceId}/values/${encodeURIComponent(markerKey)}`,{raw:true,limit:512});
    if(!value.bytes.equals(marker))fail('KV_RESTORE_OWNERSHIP_LOST');
  }
  async function put(key,data,customMetadata) {
    const body=new FormData();body.set('value',new Blob([data]),'value.bin');body.set('metadata',JSON.stringify(customMetadata));
    await request(`/${namespaceId}/values/${encodeURIComponent(key)}`,{method:'PUT',body,limit:65536});
  }
  async function inventory() {
    const expected=new Map([[markerKey,{}],...[...written].map(([key,value])=>[key,value.customMetadata])]);
    const seen=new Set(),cursors=new Set();let cursor;
    for(let page=0;page<Math.min(maxObjects+2,10000);page++){
      const params=new URLSearchParams({limit:'1000',...(cursor?{cursor}:{})});
      const result=await request(`/${namespaceId}/keys?${params}`),rows=result.result;
      if(!Array.isArray(rows)||rows.length>1000||result.result_info?.count!==rows.length)fail('KV_RESTORE_INVENTORY_INVALID');
      for(const row of rows){
        if(typeof row.name!=='string'||!expected.has(row.name)||seen.has(row.name)||row.expiration!==undefined||
          !isDeepStrictEqual(row.metadata??{},expected.get(row.name)))fail('KV_RESTORE_INVENTORY_MISMATCH');
        seen.add(row.name);
      }
      const next=result.result_info?.cursor;
      if(next===undefined||next===''){if(seen.size!==expected.size)fail('KV_RESTORE_NOT_VISIBLE');return;}
      if(typeof next!=='string'||next.length>4096||cursors.has(next))fail('KV_RESTORE_INVENTORY_INVALID');
      cursors.add(next);cursor=next;
    }
    fail('KV_RESTORE_INVENTORY_LIMIT');
  }
  return {
    async begin() {
      step('NEW');state='CREATING';
      try {
        await record({phase:'KV_CREATE_INTENT',accountId,title});
        const {result}=await request('',{method:'POST',jsonBody:{title},limit:65536});
        if(/^[a-f0-9]{32}$/.test(result?.id)){namespaceId=result.id;await record({phase:'KV_CREATED',accountId,title,namespaceId});}
        if(!namespaceId||namespaceId===sourceNamespaceId||result.title!==title)fail('KV_RESTORE_TARGET_MISMATCH');
        await visible(identity);await put(markerKey,marker,{});await visible(ownership);state='READY';
      }catch(error){failure(error);}
    },
    async putObject(object,data) {
      step('READY');state='WRITING';
      try {
        if(object.backend!=='kv'||typeof object.key!=='string'||!/^attachments\/[A-Za-z0-9_.-]+$/.test(object.key)||object.key.length>512||
          ['.','..'].includes(object.key.slice(12))||written.has(object.key)||written.size>=maxObjects||!Buffer.isBuffer(data)||data.length>maxValue||
          !validMetadata(object.customMetadata)||!object.httpMetadata||Object.keys(object.httpMetadata).length)fail('KV_RESTORE_OBJECT_INVALID');
        await visible(identity);await visible(ownership);
        await put(object.key,data,object.customMetadata);
        written.set(object.key,{size:data.length,sha256:digest(data),customMetadata:structuredClone(object.customMetadata)});
        state='READY';
      }catch(error){failure(error);}
    },
    async verify() {
      step('READY');state='VERIFYING';
      try {
        await visible(identity);await visible(ownership);await visible(inventory);
        for(const [key,expected] of written)for(let pass=0;pass<2;pass++)await visible(async()=>{
          if(!isDeepStrictEqual(await metadata(key),expected.customMetadata))fail('KV_RESTORE_DATA_MISMATCH');
          const value=await request(`/${namespaceId}/values/${encodeURIComponent(key)}`,{raw:true,retain:false,limit:maxValue});
          if(value.size!==expected.size||value.sha256!==expected.sha256)fail('KV_RESTORE_DATA_MISMATCH');
        });
        await visible(inventory);await visible(ownership);await visible(identity);state='VERIFIED';
      }catch(error){failure(error);}
    },
    result(){step('VERIFIED');return {namespaceId,title,objects:written.size,kvObjectsVerified:true,requiresAcceptance:true};},
    resource(){return {namespaceId:namespaceId??null,title,state};},
    close(){stop.abort();state='CLOSED';},
  };
}
