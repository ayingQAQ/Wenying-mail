import {withWorkBudget} from './work-budget.js';
const fail=()=>new Error('QUEUE_REMOTE_UNAVAILABLE');
export function remoteQueue({queueId,queueName,request}){
  if(!/^[a-f0-9]{32}$/.test(queueId)||!queueName)throw new Error('INVALID_QUEUE_CONFIG');
  const path=`/queues/${queueId}/messages`;
  return {
    async sendBatch(messages){
      if(!Array.isArray(messages)||!messages.length||messages.length>100)throw fail();
      const batch=messages.map(message=>{
        if(message.contentType!==undefined&&message.contentType!=='json')throw fail();
        const body=JSON.stringify(message.body);
        if(typeof body!=='string'||Buffer.byteLength(body)>128*1024)throw fail();
        if(message.delaySeconds!==undefined&&(!Number.isInteger(message.delaySeconds)||message.delaySeconds<0||message.delaySeconds>86400))throw fail();
        return {body:JSON.parse(body),content_type:'json',...(message.delaySeconds!==undefined?{delay_seconds:message.delaySeconds}:{})};
      });
      if(Buffer.byteLength(JSON.stringify(batch))>256*1024)throw fail();
      await request(`${path}/batch`,{body:{messages:batch}});
    },
    async consumeOnce(consume,env,signal){
      const result=await request(`${path}/pull`,{body:{batch_size:1,visibility_timeout_ms:1200000},signal});
      if(!Array.isArray(result?.messages)||result.messages.length>1)throw fail();
      if(!result.messages.length)return false;
      const message=result.messages[0];
      if(typeof message.lease_id!=='string'||!message.lease_id||typeof message.body!=='string'||Buffer.byteLength(message.body)>256*1024)throw fail();
      // Never deserialize V8 bytes supplied by a queue. Unsupported envelopes
      // remain unacknowledged and follow the queue's configured retry/DLQ path.
      const type=message.metadata?.['CF-Content-Type'];
      if(type!=='json')throw fail();
      let body;try{body=JSON.parse(message.body);}catch{throw fail();}
      let disposition;
      const processingStarted=Date.now();
      const set=value=>{if(disposition)throw fail();disposition=value;};
      await withWorkBudget(()=>consume({queue:queueName,messages:[{id:message.id,body,attempts:message.attempts,timestamp:new Date(message.timestamp_ms),
        ack(){set({acks:[{lease_id:message.lease_id}],retries:[]});},
        retry({delaySeconds=60}={}){if(!Number.isInteger(delaySeconds)||delaySeconds<0||delaySeconds>86400)throw fail();set({acks:[],retries:[{lease_id:message.lease_id,delay_seconds:delaySeconds}]});},
      }]},env),{signal});
      if(!disposition||signal?.aborted)throw fail();
      console.log(JSON.stringify({stage:'queue-processing',code:disposition.acks.length?'ACK_READY':'RETRY_READY',processingMs:Date.now()-processingStarted,queueAgeMs:Math.max(0,processingStarted-message.timestamp_ms)}));
      const settled=await request(`${path}/ack`,{body:disposition,signal});
      const warnings=settled?.warnings??{},errors=settled?.errors??[];
      if(settled?.ackCount!==disposition.acks.length||settled?.retryCount!==disposition.retries.length||
        !Array.isArray(errors)||errors.length||typeof warnings!=='object'||Array.isArray(warnings)||
        Object.entries(warnings).some(([lease,warning])=>disposition.retries.length!==1||lease!==message.lease_id||warning!=='Message has exhausted maxRetries'))throw fail();
      // Cloudflare counts the final retry as accepted and warns for its lease
      // when maxRetries is exhausted. The queue's configured DLQ handles it;
      // this is not a failed settlement and must not trigger transport backoff.
      return true;
    },
  };
}
