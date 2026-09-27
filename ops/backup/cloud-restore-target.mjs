// Coordinates independently guarded resources. This does not bind Workers,
// enable receiving, or turn component verification into application acceptance.
export function cloudRestoreTarget({database,r2,kv,s3,record,signal}) {
  if(!database||!r2||typeof record!=='function'||!signal)throw Error('INVALID_CLOUD_RESTORE_TARGET');
  const objects=new Map([['r2',r2],...(kv?[['kv',kv]]:[]),...(s3?[['s3',s3]]:[])]);
  let state='NEW',objectCount=0,closed=false;
  const step=(expected,next)=>{signal.throwIfAborted();if(state!==expected)throw Error('CLOUD_RESTORE_STATE_INVALID');state=next;};
  async function action(operation) {
    try{return await operation();}
    catch(error){state='FAILED';throw error;}
  }
  return {
    supportedBackends:Object.freeze([...objects.keys()]),
    async begin(){
      step('NEW','STARTING');
      return action(async()=>{
        await record({phase:'CLOUD_RESTORE_STARTED'});
        await database.begin();
        for(const target of objects.values())await target.begin({signal});
        state='READY';
      });
    },
    async putObject(object,data){
      step('READY','WRITING');
      return action(async()=>{
        const target=objects.get(object.backend);if(!target)throw Error('CLOUD_RESTORE_BACKEND_UNSUPPORTED');
        await target.putObject(object,data,{signal});objectCount++;state='READY';
      });
    },
    async importDatabase(sql){
      step('READY','IMPORTING');
      return action(async()=>{await database.importDatabase(sql,{signal});state='IMPORTED';});
    },
    async verify(contract){
      step('IMPORTED','VERIFYING');
      return action(async()=>{
        // KV propagation can take time. Verify object stores before the D1
        // stability interval so object waits do not invalidate its bookmark.
        for(const target of objects.values())await target.verify({signal});
        await database.verify(contract,{signal});state='VERIFIED';
      });
    },
    async finish(report){
      step('VERIFIED','FINISHING');
      return action(async()=>{
        const result=await database.finish(),completedAt=Date.now();
        if(result?.databaseVerified!==true||result.receivingEnabled!==false||result.requiresAcceptance!==true)throw Error('CLOUD_RESTORE_DATABASE_UNVERIFIED');
        const final={...report,...result,environment:'cloudflare-isolated',objectsVerified:[...objects.keys()],objectCount,
          ...(kv?{kv:kv.result()}:{}),completedAt,elapsedMs:completedAt-report.startedAt,
          deletionUncertainty:{from:report.ledgerThrough,to:completedAt},sessionsRestored:false,receivingEnabled:false,requiresAcceptance:true};
        await record({phase:'CLOUD_RESTORE_COMPLETE',report:final});state='COMPLETE';return final;
      });
    },
    async close(){
      if(closed)return;closed=true;state='CLOSED';
      const results=await Promise.allSettled([database,...objects.values()].map(target=>Promise.resolve().then(()=>target.close())));
      if(results.some(result=>result.status==='rejected'))throw Error('CLOUD_RESTORE_CLOSE_FAILED');
    },
  };
}
