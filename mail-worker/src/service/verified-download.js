import {createHash} from 'node:crypto';
import {fixedLengthStream} from '../runtime/fixed-length.js';

const fail=()=>new Error('CONTENT_UNAVAILABLE');
const MAX=25*1024*1024;
const BLOCK=256*1024;

// Read once, retain only a signature prefix and the source's current chunk.
// Withhold the final byte until the digest AND final authorization check pass.
// Stream failures propagate through FixedLengthStream to abort the download.
export async function verifiedDownload(object,{size,sha256,finish,prefixLength=0}) {
  if(!Number.isSafeInteger(size)||size<0||size>MAX||object?.size!==size||
    typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||
    !object.body?.getReader||typeof finish!=='function'||![0,12].includes(prefixLength)){
    await object?.body?.cancel().catch(()=>{});throw fail();
  }
  let reader,byob=false;
  try{reader=object.body.getReader({mode:'byob'});byob=true;}
  catch{reader=object.body.getReader();}
  const hash=createHash('sha256');
  const prefix=new Uint8Array(Math.min(size,prefixLength)),queued=[];
  let prefixOffset=0,ended=false,closed=false,seen=0,last=null,empty=0;
  function read(minimum=BLOCK){
    if(!byob)return reader.read();
    // Native R2 readAtLeast coalesces small network fragments without waking JS
    // for each fragment. Never reuse a transferred BYOB buffer.
    const length=Math.max(1,Math.min(BLOCK,size-seen));
    const view=new Uint8Array(length);
    return typeof reader.readAtLeast==='function'
      ?reader.readAtLeast(Math.min(minimum,length),view):reader.read(view);
  }
  function release(){try{reader.releaseLock();}catch{};hash.destroy();queued.length=0;last=null;}
  async function cancel(){if(closed)return;closed=true;try{await reader.cancel();}catch{}finally{release();}}
  try {
    while(prefixOffset<prefix.length){
      const item=await read(prefix.length-prefixOffset);
      if(item.done){ended=true;break;}
      if(!(item.value instanceof Uint8Array)||item.value.length>size||++empty>1024)throw fail();
      if(!item.value.length)continue;
      queued.push(item.value);
      const part=item.value.subarray(0,prefix.length-prefixOffset);
      prefix.set(part,prefixOffset);prefixOffset+=part.length;
    }
    if(prefixOffset!==prefix.length)throw fail();
    // A zero-length body cannot withhold a last byte: verify it before headers.
    if(size===0){
      const item=await read(1);
      if(!item.done||hash.digest('hex')!==sha256)throw fail();
      await finish();closed=true;release();
      return {prefix,body:new Uint8Array(0),cancel:async()=>{}};
    }
  }catch{await cancel();throw fail();}
  empty=0;
  const source=new ReadableStream({
    async pull(controller){
      try {
        // Empty chunks and a one-byte final chunk produce no output yet.
        for(;;){
          const item=queued.length?{value:queued.shift(),done:false}:ended?{done:true}:await read();
          if(closed)return;
          if(item.done){
            if(seen!==size||hash.digest('hex')!==sha256)throw fail();
            await finish();if(closed)return;
            controller.enqueue(last);controller.close();closed=true;release();return;
          }
          const value=item.value;
          if(!(value instanceof Uint8Array)||seen+value.length>size)throw fail();
          if(!value.length){if(++empty>1024)throw fail();continue;}
          empty=0;hash.update(value);seen+=value.length;
          if(seen<size){controller.enqueue(value);return;}
          // Only split the actual final block, not every input block. Avoid
          // producing thousands of separate one-byte output chunks.
          last=Uint8Array.of(value[value.length-1]);
          if(value.length>1){controller.enqueue(value.subarray(0,value.length-1));return;}
        }
      }catch{await cancel();controller.error(fail());}
    },
    cancel,
  },{highWaterMark:0});
  const fixed=fixedLengthStream(size);
  // The response owns this pipeline. pipeTo propagates error/cancellation in
  // both directions; this catch only consumes its already-propagated rejection.
  const completion=source.pipeTo(fixed.writable).catch(()=>{});
  return {prefix,body:fixed.readable,completion,cancel:async()=>{await fixed.readable.cancel();await completion;}};
}
