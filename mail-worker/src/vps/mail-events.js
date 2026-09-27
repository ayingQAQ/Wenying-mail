// Process-local notifications: D1 remains authoritative; reconnect sends ready so
// clients reconcile missed events. No mail content or identity crosses this stream.
export function mailEvents({heartbeatMs=20000,lifetimeMs=600000}={}) {
 const clients=new Map(),encoder=new TextEncoder();
 return {
  close(){for(const group of [...clients.values()])for(const client of [...group])client.close();},
  publish(userId){for(const client of clients.get(userId)||[])client.notify();},
  open({userId,signal,expiresAt,verify}){
   let close;const stream=new ReadableStream({start(controller){
    let stopped=false,checking=false,dirty=false,heartbeat,expiry;
    const send=event=>{if(stopped)return;try{if(controller.desiredSize<=0){close();return;}controller.enqueue(encoder.encode(event));}catch{close();}};
    const client={close:()=>close(),async notify(){dirty=true;if(checking||stopped)return;checking=true;try{while(dirty&&!stopped){dirty=false;if(!await verify()){close();break;}send('event: mail\ndata: {}\n\n');}}catch{close();}finally{checking=false;}}};
    close=()=>{if(stopped)return;stopped=true;clearInterval(heartbeat);clearTimeout(expiry);signal.removeEventListener('abort',close);const group=clients.get(userId);group?.delete(client);if(!group?.size)clients.delete(userId);try{controller.close();}catch{}};
    if(signal.aborted){close();return;}
    if(!clients.has(userId))clients.set(userId,new Set());clients.get(userId).add(client);
    signal.addEventListener('abort',close,{once:true});
    heartbeat=setInterval(()=>send(': keepalive\n\n'),heartbeatMs);
    expiry=setTimeout(close,Math.max(0,Math.min(lifetimeMs,expiresAt-Date.now())));
    send('retry: 3000\nevent: ready\ndata: {}\n\n');
   },cancel(){close?.();}});
   return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
  }
 };
}
