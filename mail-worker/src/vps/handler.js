import {timingSafeEqual} from 'node:crypto';
const deny=(code,status)=>Response.json({code},{status,headers:{'Cache-Control':'no-store'}});
// The public origin is pinned by configuration, never taken from forwarded
// headers. The application verifies its session and the configured login mode.
export function vpsHandler({worker,env,ingressHost,originToken,wakeToken,wakeup,maxActive=8,maxBodyBytes=1024*1024}){
  const origin=new URL(env.APP_ORIGIN);
  if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN||!ingressHost||!/^([a-z0-9.-]+)(:\d+)?$/.test(ingressHost)||
    !/^[a-f0-9]{64}$/.test(originToken)||!Number.isInteger(maxActive)||maxActive<1||maxActive>32)throw new Error('INVALID_VPS_INGRESS');
  let active=0,eventConnections=0;
  return async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/healthz'&&request.method==='GET')return new Response('ok',{headers:{'Cache-Control':'no-store'}});
    if(url.host!==ingressHost)return deny('HOST_NOT_ALLOWED',403);
    if(url.pathname==='/api/internal/queue-wake'){
      const key=request.headers.get('X-Cloudmail-Wake-Token');
      if(!wakeup||!wakeToken||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||!timingSafeEqual(Buffer.from(key),Buffer.from(wakeToken)))return deny('WAKE_AUTH_REQUIRED',403);
      if(request.method!=='POST'||url.search)return deny('INVALID_WAKE_REQUEST',400);
      // No message bodies, object keys or user identities are accepted here.
      if(request.body)await request.body.cancel();
      wakeup.wake();
      console.log('{"stage":"queue-wake","code":"ACCEPTED"}');
      return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
    }
    const supplied=request.headers.get('X-Cloudmail-Origin-Token');
    if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(originToken)))return deny('ORIGIN_AUTH_REQUIRED',403);
    if(!url.pathname.startsWith('/api/')&&url.pathname!=='/ops/backup/hold')return deny('NOT_FOUND',404);
    const eventStream=url.pathname==='/api/email/events'&&request.method==='GET';
    if(eventStream?eventConnections>=24:active>=maxActive)return deny('SERVICE_BUSY',503);
    if(eventStream)eventConnections++;else active++;
    let streaming=false,released=false;
    const release=()=>{if(!released){released=true;if(eventStream)eventConnections--;else active--;}};
    try{
      const headers=new Headers(request.headers);headers.delete('X-Cloudmail-Origin-Token');
      for(const name of ['Forwarded','X-Forwarded-Host','X-Forwarded-Proto','X-Forwarded-For','Host'])headers.delete(name);
      let body;
      if(!['GET','HEAD'].includes(request.method)){
        if(Number(request.headers.get('Content-Length'))>maxBodyBytes)return deny('REQUEST_TOO_LARGE',413);
        const reader=request.body?.getReader(),chunks=[];let size=0;
        try{if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBodyBytes){await reader.cancel();return deny('REQUEST_TOO_LARGE',413);}chunks.push(part.value);}}
        finally{reader?.releaseLock();}
        body=Buffer.concat(chunks);headers.delete('Content-Length');
      }
      const target=new URL(env.APP_ORIGIN);target.pathname=url.pathname;target.search=url.search;
      const context={waitUntil(promise){promise.catch(()=>{console.error('{"stage":"vps-background","code":"FAILED"}');});}};
      const response=await worker.fetch(new Request(target,{method:request.method,headers,body,signal:request.signal}),env,context);
      if(!response.body)return response;
      const reader=response.body.getReader();
      // Hold the permit through EOF or cancellation, including slow downloads.
      let closed=false;
      const done=()=>{if(closed)return;closed=true;request.signal.removeEventListener('abort',abort);release();};
      const abort=()=>{reader.cancel().catch(()=>{});done();};
      request.signal.addEventListener('abort',abort,{once:true});
      if(request.signal.aborted)abort();
      const stream=new ReadableStream({
        async pull(controller){try{const item=await reader.read();if(item.done){controller.close();done();}else controller.enqueue(item.value);}catch(error){done();controller.error(error);}},
        async cancel(reason){try{await reader.cancel(reason);}finally{done();}},
      },{highWaterMark:0});
      streaming=true;return new Response(stream,response);
    }catch{return deny('SERVICE_UNAVAILABLE',503);}
    finally{if(!streaming)release();}
  };
}
