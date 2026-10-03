export async function notifyVps(env,fetcher=fetch,reference) {
  if(!env.VPS_WAKE_ORIGIN&&!env.VPS_WAKE_TOKEN)return;
  try {
    const origin=new URL(env.VPS_WAKE_ORIGIN);
    if(origin.protocol!=='https:'||origin.origin!==env.VPS_WAKE_ORIGIN||! /^[a-f0-9]{64}$/.test(env.VPS_WAKE_TOKEN))throw Error();
    const response=await fetcher(origin.origin+'/api/internal/queue-wake',{
      method:'POST',headers:{'X-Cloudmail-Wake-Token':env.VPS_WAKE_TOKEN},
      ...(reference?{body:JSON.stringify({version:1,kind:'process',rawKey:reference.rawKey,deliveryId:reference.deliveryId})}:{}),
      redirect:'manual',signal:AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    if(response.status!==202){console.error(JSON.stringify({stage:'queue-wake',code:'HTTP_REJECTED',status:response.status}));return;}
    console.log('{"stage":"queue-wake","code":"DELIVERED"}');
  } catch {console.error('{"stage":"queue-wake","code":"FALLBACK_POLL"}');}
}
