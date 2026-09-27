export async function proxyVps(request,env,fetcher=fetch){
  try{
    const origin=new URL(env.VPS_API_ORIGIN);
    if(origin.protocol!=='https:'||origin.origin!==env.VPS_API_ORIGIN||origin.origin===env.APP_ORIGIN||! /^[a-f0-9]{64}$/.test(env.VPS_PROXY_TOKEN))throw new Error();
    const url=new URL(request.url),target=new URL(origin);target.pathname=url.pathname;target.search=url.search;
    const headers=new Headers(request.headers);
    for(const name of ['Host','Forwarded','X-Forwarded-Host','X-Forwarded-Proto','X-Forwarded-For','Connection','Transfer-Encoding'])headers.delete(name);
    headers.set('X-Cloudmail-Origin-Token',env.VPS_PROXY_TOKEN);
    const response=await fetcher(new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,
      duplex:'half',redirect:'manual',signal:request.signal}));
    if(response.status>=300&&response.status<400){
      // Only the verified login callback may redirect, to fixed local UI paths.
      const loginRedirect=env.MAIL_AUTH_MODE==='either' && request.method==='GET'
        && url.pathname==='/api/login/access/callback' && response.status===303
        && ['/inbox','/login?emailLogin=failed'].includes(response.headers.get('Location'));
      if(!loginRedirect){await response.body?.cancel();throw new Error();}
    }
    const result=new Response(response.body,response);result.headers.set('Cache-Control',response.headers.get('Content-Type')?.startsWith('text/event-stream')?'private, no-store, no-transform':'private, no-store');return result;
  }catch{return Response.json({code:'VPS_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
