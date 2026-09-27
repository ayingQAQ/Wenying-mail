const fail=()=>{throw Error('R2_RESTORE_ISOLATION_FAILED');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// Read-only native R2 checks; this does not enumerate Worker bindings and is not
// a lock against another administrator changing configuration concurrently.
export function r2RestoreIsolation({accountId,bucket,apiToken,fetcher=fetch}) {
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||
    typeof apiToken!=='string'||!apiToken||apiToken.length>4096||/[\s\x00]/.test(apiToken))fail();
  const root=`https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function get(path,signal,noNotificationResponse=false){
    let response;
    try{
      signal.throwIfAborted();response=await fetcher(root+path,{method:'GET',headers:{authorization:'Bearer '+apiToken},redirect:'error',signal});
      if((!response.ok&&!(noNotificationResponse&&response.status===404))||response.redirected||!response.body)fail();
      let size=0;const chunks=[];
      for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>65536)fail();chunks.push(Buffer.from(chunk));}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Cloudflare documents this exact 404 as an empty notification config.
      // Missing bucket, denied access and all other 404s still fail closed.
      if(noNotificationResponse&&response.status===404&&result.success===false&&result.result===null&&
        Array.isArray(result.errors)&&result.errors.length===1&&result.errors[0]?.code===11015)return {bucketName:bucket,queues:[]};
      if(!response.ok)fail();
      if(result.success!==true||!Array.isArray(result.errors)||result.errors.length||!object(result.result)||result.result_info!==undefined)fail();
      return result.result;
    }catch{fail();}finally{await response?.body?.cancel().catch(()=>{});}
  }
  return async signal=>{
    const path=`/r2/buckets/${bucket}`;
    const managed=await get(path+'/domains/managed',signal),custom=await get(path+'/domains/custom',signal);
    if(managed.enabled!==false||typeof managed.bucketId!=='string'||typeof managed.domain!=='string'||!Array.isArray(custom.domains)||custom.domains.length)fail();
    const lifecycle=await get(path+'/lifecycle',signal);
    if(!Array.isArray(lifecycle.rules)||lifecycle.rules.length>1000)fail();
    const ids=new Set();
    for(const rule of lifecycle.rules){
      if(!object(rule)||typeof rule.id!=='string'||!rule.id||ids.has(rule.id)||typeof rule.enabled!=='boolean'||
        !object(rule.conditions)||(rule.conditions.prefix!==undefined&&typeof rule.conditions.prefix!=='string')||
        Object.keys(rule).some(key=>!['id','enabled','conditions','abortMultipartUploadsTransition','deleteObjectsTransition','storageClassTransitions'].includes(key)))fail();
      ids.add(rule.id);
      // The normal unfinished-upload cleanup does not delete completed PUTs.
      // Reject active deletion/storage-class rules even if their prefix appears
      // unrelated: restore targets must retain all data through acceptance.
      if(rule.enabled&&(rule.deleteObjectsTransition!==undefined||
        rule.storageClassTransitions!==undefined&&(!Array.isArray(rule.storageClassTransitions)||rule.storageClassTransitions.length)))fail();
      if(rule.abortMultipartUploadsTransition!==undefined){
        const condition=rule.abortMultipartUploadsTransition?.condition;
        if(!object(condition)||condition.type!=='Age'||!Number.isFinite(condition.maxAge)||condition.maxAge<=0)fail();
      }
    }
    const notifications=await get(`/event_notifications/r2/${bucket}/configuration`,signal,true);
    if(notifications.bucketName!==bucket||!Array.isArray(notifications.queues)||notifications.queues.length)fail();
  };
}
