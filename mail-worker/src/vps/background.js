import {setTimeout as sleep} from 'node:timers/promises';
import {withWorkBudget} from './work-budget.js';
import {recoverMail} from '../processing/recovery.js';
export const MAINTENANCE_INTERVAL_MS=5*60*1000;
// One process owns each enabled loop. D1 fencing still protects against a
// process restart or a temporarily overlapping deployment.
export async function runBackground({worker,config,signal,wakeup,recovery=recoverMail}){
  let delay=5000,nextMaintenance=Date.now()+MAINTENANCE_INTERVAL_MS;
  while(!signal.aborted){
    let worked=false;
    try{
      if(config.consume)for(const queue of config.queues){if(signal.aborted)break;worked=(await queue.consumeOnce(worker.queue,config.env,signal))||worked;}
      if((config.maintenance||config.env?.MAIL_RECOVERY_ENABLED==='true')&&Date.now()>=nextMaintenance&&!signal.aborted){
        // Set before dispatch so failures cannot turn into a rapid full scan.
        nextMaintenance=Date.now()+MAINTENANCE_INTERVAL_MS;
        // Recovery-only mode must not execute scheduled metadata retention,
        // backup state expiry, deletion, purge or generation collection.
        await withWorkBudget(()=>config.maintenance?worker.scheduled({},config.env,{}):recovery(config.env),{signal});
      }
      delay=worked?1000:Math.min(30000,Math.max(5000,delay*2));
    }catch{console.error('{"stage":"vps-background","code":"RETRY_LATER"}');delay=Math.min(60000,Math.max(10000,delay*2));}
    try{if(wakeup)await wakeup.wait(delay,signal);else await sleep(delay,undefined,{signal});}catch{break;}
  }
}
