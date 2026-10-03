import {createVpsServer} from './http.js';
import worker from '../index.js';
import {runtimeConfig} from './config.js';
import {vpsHandler} from './handler.js';
import {runBackground} from './background.js';
import {mailEvents} from './mail-events.js';
import {queueWakeup} from './queue-wakeup.js';
import {createTelegramBot} from './telegram-bot.js';
import {homedir} from 'node:os';
import {join} from 'node:path';

let config;
try{config=runtimeConfig(process.env);}catch{console.error('{"stage":"startup","code":"CONFIGURATION_INVALID"}');process.exit(1);}
config.env.MAIL_EVENTS=mailEvents();
const controller=new AbortController();
let telegram;
try{telegram=await createTelegramBot({env:config.env,path:join(homedir(),'cloud-mail','telegram-state.json')});}
catch{console.error('{"stage":"startup","code":"TELEGRAM_STATE_INVALID"}');config.close();process.exit(1);}
if(telegram)config.env.TELEGRAM_MAILBOX_ALLOWED=telegram.allowed;
const telegramLoop=telegram?.run(controller.signal)||Promise.resolve();
const wakeup=config.consume?queueWakeup():undefined;
const server=createVpsServer(vpsHandler({worker,...config,wakeup}));
server.listen(config.port,config.bindAddress,()=>console.log(JSON.stringify({stage:'startup',code:'LISTENING',host:config.bindAddress,port:config.port,consumer:config.consume,maintenance:config.maintenance,recovery:config.env.MAIL_RECOVERY_ENABLED==='true'})));
const background=config.consume||config.maintenance||config.env.MAIL_RECOVERY_ENABLED==='true'?runBackground({worker,config,signal:controller.signal,wakeup}):Promise.resolve();
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;controller.abort();config.env.MAIL_EVENTS.close();
  const deadline=setTimeout(()=>{server.closeAllConnections();config.close();process.exit(1);},30000);deadline.unref();
  await Promise.all([new Promise(resolve=>server.close(resolve)),background,telegramLoop]);config.close();clearTimeout(deadline);
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
server.on('error',()=>{console.error('{"stage":"server","code":"FAILED"}');controller.abort();config.close();process.exitCode=1;});
