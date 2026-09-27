import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

// In particular, never append an error body to a partly transmitted file. That
// could fill Content-Length with error text and disguise a failed digest.
export function createVpsServer(fetchHandler){
  const server=createServer({maxHeaderSize:32768,requestTimeout:30000,headersTimeout:10000,keepAliveTimeout:5000},async(incoming,outgoing)=>{
    const controller=new AbortController();
    const abort=()=>controller.abort();incoming.once('aborted',abort);outgoing.once('close',abort);
    try{
      if(!incoming.url?.startsWith('/')||incoming.url.startsWith('//')||!incoming.headers.host||
        !/^[a-z0-9.-]+(?::\d+)?$/i.test(incoming.headers.host)){outgoing.writeHead(400);outgoing.end();incoming.resume();return;}
      const method=incoming.method,headers=new Headers();
      for(let index=0;index<incoming.rawHeaders.length;index+=2)headers.append(incoming.rawHeaders[index],incoming.rawHeaders[index+1]);
      if(['GET','HEAD'].includes(method)&&(Number(headers.get('content-length'))>0||headers.has('transfer-encoding'))){outgoing.writeHead(400);outgoing.end();incoming.resume();return;}
      const request=new Request(`http://${incoming.headers.host}${incoming.url}`,{method,headers,signal:controller.signal,
        ...(!['GET','HEAD'].includes(method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
      const response=await fetchHandler(request);
      outgoing.statusCode=response.status;
      for(const [name,value] of response.headers)if(name!=='set-cookie')outgoing.setHeader(name,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader('Set-Cookie',cookies);
      if(!response.body||method==='HEAD'){await response.body?.cancel();outgoing.end();return;}
      await pipeline(Readable.fromWeb(response.body),outgoing,{signal:controller.signal});
    }catch{
      // Destroy even if headers have not yet been sent; no private/error bytes
      // are substituted into the response, and the caller cannot accept it.
      outgoing.destroy();
    }finally{incoming.removeListener('aborted',abort);outgoing.removeListener('close',abort);if(!incoming.complete)incoming.resume();}
  });
  server.maxConnections=64;return server;
}
