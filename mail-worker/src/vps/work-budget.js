import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage();
export const JOB_BUDGET_MS=15*60*1000;

// Each async job carries its own deadline. No process-global mutable signal:
// simultaneous interactive requests must not inherit a queue job's timeout.
export function transportSignal(timeoutMs,signal){
  const signals=[context.getStore(),signal].filter(Boolean);
  for(const item of signals)item.throwIfAborted();
  signals.push(AbortSignal.timeout(timeoutMs));
  return AbortSignal.any(signals);
}
export async function withWorkBudget(work,{signal,timeoutMs=JOB_BUDGET_MS}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>JOB_BUDGET_MS)throw new Error('INVALID_WORK_BUDGET');
  const deadline=new AbortController();
  const signals=[deadline.signal,context.getStore(),signal].filter(Boolean),combined=AbortSignal.any(signals);
  combined.throwIfAborted();
  const timer=setTimeout(()=>deadline.abort(new Error('WORK_DEADLINE_EXCEEDED')),timeoutMs);timer.unref();
  try{return await context.run(combined,async()=>{const result=await work(combined);combined.throwIfAborted();return result;});}
  finally{clearTimeout(timer);}
}
