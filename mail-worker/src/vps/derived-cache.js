// Only immutable generation body/manifest objects are cached. The application's
// owner, tombstone, generation and checksum checks still run on every request.
const eligible=key=>/^derived\/[a-f0-9-]{36}\/[a-f0-9]{64}\/(manifest\.json|body\.(html|txt))$/.test(key);
export function cachedDerivedStorage(storage,{maxBytes=32*1024*1024,maxEntries=256,ttlMs=600000,now=Date.now}={}){
 const cache=new Map();let size=0,epoch=0;
 function remove(key){const entry=cache.get(key);if(entry){size-=entry.bytes.length;cache.delete(key);}}
 function object(entry){const bytes=Uint8Array.from(entry.bytes),body=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}});
  return {...structuredClone(entry.metadata),body,arrayBuffer:()=>new Response(body).arrayBuffer(),text:()=>new Response(body).text(),json:()=>new Response(body).json()};}
 const result={...storage,
  async get(key){
   if(!eligible(key))return storage.get(key);
   const hit=cache.get(key);if(hit&&hit.expires>now()){cache.delete(key);cache.set(key,hit);return object(hit);}remove(key);
   const version=epoch,value=await storage.get(key);
   if(!value||value.size>4*1024*1024||!value.checksums?.sha256)return value;
   let bytes;
   try{bytes=new Uint8Array(await value.arrayBuffer());if(bytes.length!==value.size)throw Error('CACHE_LENGTH_MISMATCH');
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),expected=new Uint8Array(value.checksums.sha256);
    if(digest.length!==expected.length||digest.some((byte,index)=>byte!==expected[index]))throw Error('CACHE_DIGEST_MISMATCH');
   }catch{await value.body?.cancel().catch(()=>{});throw Error('DERIVED_CONTENT_UNAVAILABLE');}
   const {body,arrayBuffer,text,json,...metadata}=value;
   const entry={bytes,metadata:structuredClone(metadata),expires:now()+ttlMs};
   if(version===epoch&&bytes.length<=maxBytes){remove(key);
    while(cache.size&&(size+bytes.length>maxBytes||cache.size>=maxEntries))remove(cache.keys().next().value);
    cache.set(key,entry);size+=bytes.length;
   }return object(entry);
  },
  async put(key,...args){epoch++;remove(key);try{return await storage.put(key,...args);}finally{epoch++;remove(key);}},
  async delete(keys){epoch++;for(const key of Array.isArray(keys)?keys:[keys])remove(key);return storage.delete(keys);},
  close(){cache.clear();size=0;epoch++;storage.close();},
 };return result;
}
