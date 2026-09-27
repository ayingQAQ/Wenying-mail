export function backupHoldClient({origin,clientId,clientSecret,fetcher=fetch}) {
  const url=new URL('/ops/backup/hold',origin);
  if(url.protocol!=='https:' || url.origin!==origin || !clientId || !clientSecret) throw new Error('INVALID_BACKUP_ENDPOINT');
  async function call(action,owner,signal,extra={}) {
    const response=await fetcher(url,{method:'POST',redirect:'error',signal,headers:{
      'Content-Type':'application/json','CF-Access-Client-Id':clientId,'CF-Access-Client-Secret':clientSecret,
    },body:JSON.stringify({action,...(owner?{owner}:{}),...extra})});
    if(!response.ok) throw new Error(response.status===409?'BACKUP_HOLD_LOST':'BACKUP_HOLD_UNAVAILABLE');
    const result=await response.json();
    if(['acquire','renew','assert'].includes(action) && (!/^[a-f0-9-]{36}$/.test(result.owner || '') || !Number.isSafeInteger(result.expiresAt))) throw new Error('INVALID_BACKUP_HOLD');
    return result;
  }
  return {acquire:signal=>call('acquire',undefined,signal),renew:(owner,signal)=>call('renew',owner,signal),
    assert:(owner,signal)=>call('assert',owner,signal),release:(owner,signal)=>call('release',owner,signal),
    complete:(owner,receipt,signal)=>call('complete',owner,signal,receipt),fail:(owner,signal)=>call('fail',owner,signal),
    offsite:(receipt,signal)=>call('offsite',undefined,signal,receipt)};
}

export async function withBackupHold(client,work,{maxRunMs,renewEveryMs=60000,signal}={}) {
  if(!Number.isSafeInteger(maxRunMs) || maxRunMs<=0 || !Number.isSafeInteger(renewEveryMs) || renewEveryMs<=0 || renewEveryMs>=1800000)
    throw new Error('INVALID_BACKUP_DEADLINE');
  const controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timeout=setTimeout(()=>controller.abort(),maxRunMs);
  let hold,timer,pending=Promise.resolve(),lost=false;
  try {
    hold=await client.acquire(combined);
    timer=setInterval(()=>{
      pending=pending.then(async()=>{if(lost || combined.aborted)return;try{await client.renew(hold.owner,combined);}catch{lost=true;controller.abort();}});
    },renewEveryMs);
    const result=await work({owner:hold.owner,signal:combined,assert:async()=>{
      if(lost || combined.aborted) throw new Error('BACKUP_HOLD_LOST');await client.assert(hold.owner,combined);
    }});
    clearInterval(timer);await pending;
    if(lost || combined.aborted) throw new Error('BACKUP_HOLD_LOST');
    await client.assert(hold.owner,combined);
    return result;
  } catch(error) {
    if(hold&&client.fail)await client.fail(hold.owner,AbortSignal.timeout(10000)).catch(()=>{});
    throw error;
  } finally {
    clearTimeout(timeout);clearInterval(timer);await pending;
    if(hold) await client.release(hold.owner,AbortSignal.timeout(10000)).catch(()=>{});
  }
}
