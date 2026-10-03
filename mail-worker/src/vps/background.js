import {setTimeout as sleep} from 'node:timers/promises';
import {withWorkBudget} from './work-budget.js';
import {recoverMail} from '../processing/recovery.js';
export const MAINTENANCE_INTERVAL_MS=5*60*1000;
// One process owns each enabled loop. D1 fencing still protects against a
// process restart or a temporarily overlapping deployment.
export async function runBackground({worker,config,signal,wakeup,recovery=recoverMail}){
  let delay=5000,nextMaintenance=Date.now()+MAINTENANCE_INTERVAL_MS,nextAdmission=0;
  while(!signal.aborted){
    let worked=false,queueFailed=false;
    try{
      if(config.env?.db?.reconcileAdmission&&Date.now()>=nextAdmission&&!signal.aborted){
        nextAdmission=Date.now()+30000;
        try{await config.env.db.reconcileAdmission();}catch{console.error('{"stage":"admission-sync","code":"RETRY_LATER"}');}
      }
      const hint=config.consume?wakeup?.take?.():undefined;
      if(hint&&!signal.aborted){
        const started=Date.now();let disposition='NO_DISPOSITION';
        try{await withWorkBudget(()=>worker.queue({queue:config.env.MAIL_QUEUE_NAME,messages:[{id:hint.deliveryId,body:hint,attempts:1,timestamp:new Date(),ack(){disposition='ACK';},retry(){disposition='QUEUE_FALLBACK';}}]},config.env),{signal});worked=true;}
        catch{disposition='QUEUE_FALLBACK';}
        console.log(JSON.stringify({stage:'direct-processing',code:disposition,processingMs:Date.now()-started}));
      }
      if(config.consume)for(const queue of config.queues){
        if(signal.aborted)break;
        try{worked=(await queue.consumeOnce(worker.queue,config.env,signal))||worked;}
        catch{queueFailed=true;console.error('{"stage":"vps-queue","code":"RETRY_LATER"}');}
      }
      if((config.maintenance||config.env?.MAIL_RECOVERY_ENABLED==='true')&&Date.now()>=nextMaintenance&&!signal.aborted){
        // Set before dispatch so failures cannot turn into a rapid full scan.
        nextMaintenance=Date.now()+MAINTENANCE_INTERVAL_MS;
        const stage=config.maintenance?'vps-maintenance':'vps-recovery',started=Date.now();
        console.log(JSON.stringify({stage,code:'STARTED'}));
        // Recovery-only mode must not execute scheduled metadata retention,
        // backup state expiry, deletion, purge or generation collection.
        try{
          await withWorkBudget(()=>config.maintenance?worker.scheduled({},config.env,{}):recovery(config.env),{signal});
          console.log(JSON.stringify({stage,code:'COMPLETED',durationMs:Date.now()-started}));
        }catch(error){
          console.error(JSON.stringify({stage,code:signal.aborted?'CANCELLED':'FAILED',durationMs:Date.now()-started}));
          throw error;
        }
      }
      delay=queueFailed?Math.min(60000,Math.max(10000,delay*2)):worked?1000:Math.min(30000,Math.max(5000,delay*2));
    }catch{console.error('{"stage":"vps-background","code":"RETRY_LATER"}');delay=Math.min(60000,Math.max(10000,delay*2));}
    try{if(wakeup)await wakeup.wait(delay,signal);else await sleep(delay,undefined,{signal});}catch{break;}
  }
}
