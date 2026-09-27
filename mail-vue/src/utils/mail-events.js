// One stream per mounted inbox. Hidden/offline pages disconnect; ready on each
// new connection reconciles events missed during suspension or server restarts.
export function subscribeMailEvents(onChange,{Source=EventSource,page=document,network=window}={}){
 let source,retry,closed=false,delay=3000;
 const stop=()=>{clearTimeout(retry);source?.close();source=undefined;};
 const connect=()=>{stop();if(closed||page.hidden)return;source=new Source('/api/email/events');
  source.addEventListener('ready',()=>{delay=3000;onChange();});
  source.addEventListener('mail',onChange);
  source.onerror=()=>{stop();retry=setTimeout(connect,delay);delay=Math.min(60000,delay*2);};
 };
 const visibility=()=>{if(page.hidden)stop();else connect();};
 const offline=()=>stop();
 page.addEventListener('visibilitychange',visibility);network.addEventListener('online',connect);network.addEventListener('offline',offline);connect();
 return ()=>{closed=true;stop();page.removeEventListener('visibilitychange',visibility);network.removeEventListener('online',connect);network.removeEventListener('offline',offline);};
}
