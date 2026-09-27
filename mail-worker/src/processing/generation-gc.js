import {acquireStorageLock,assertStorageLock,releaseStorageLock} from './storage-lock.js';

const NOW='unixepoch()*1000';
const JOB='generation-gc';
const KINDS=['derived','attachments','inline'];
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT=50;
// Allow the full 20-minute processor lease plus a safety minute, including
// writes from an older attempt that was displaced by the successful attempt.
const eligible=`e.storage_version='r2-v1' AND e.delete_state='ACTIVE' AND e.is_del=0
  AND e.processing_status='PROCESSED' AND p.state='PROCESSED' AND p.email_id=e.email_id
  AND p.user_id=e.user_id AND p.account_id=e.account_id AND p.raw_key=e.raw_r2_key
  AND p.lease_owner IS NULL AND p.lease_until=0 AND p.updated_at<=${NOW}-1260000
  AND e.processed_at<=${NOW}-1260000
  AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=e.delivery_id)
  AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=e.delivery_id)`;
const from='FROM email e JOIN mail_processing p ON p.delivery_id=e.delivery_id';
const lockGate=`EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1
  AND kind='PURGE' AND owner=? AND expires_at>${NOW})`;
const fresh=(after=0)=>({after,email:null,generation:null,kind:0,continuation:null});
const fail=()=>{throw new Error('GENERATION_GC_RETRY');};

function decode(value) {
  const state=value===null ? fresh():JSON.parse(value);
  if(!state||!Number.isSafeInteger(state.after)||state.after<0||
    !(state.email===null||Number.isSafeInteger(state.email)&&state.email>state.after)||
    !(state.generation===null||typeof state.generation==='string'&&HASH.test(state.generation))||
    !Number.isInteger(state.kind)||state.kind<0||state.kind>2||
    !(state.continuation===null||typeof state.continuation==='string'&&state.continuation.length<=8192))fail();
  return state;
}

// One email / one generation / one object page per invocation. The durable
// generation survives a crash between index retirement and R2 deletion.
export async function collectOldGenerations(env) {
  const {db,r2}=env;
  const lock=await acquireStorageLock(db,'PURGE');
  if(!lock)return {busy:true};
  let state,row;
  async function save(next) {
    const result=await db.prepare(`UPDATE recovery_cursors SET cursor=?,updated_at=${NOW}
      WHERE job_name=? AND ${lockGate}`).bind(JSON.stringify(next),JOB,lock.owner).run();
    if(result.meta.changes!==1)fail();
    state=next;
  }
  async function current() {
    await assertStorageLock(db,lock);
    if(!await db.prepare(`SELECT 1 ${from} WHERE e.email_id=? AND e.delivery_id=?
      AND e.published_generation=? AND ${eligible}`)
      .bind(row.email_id,row.delivery_id,row.published_generation).first())fail();
  }
  async function retireIndices(keys) {
    const gate=`${lockGate} AND EXISTS(SELECT 1 ${from} WHERE e.email_id=? AND e.delivery_id=?
      AND e.published_generation=? AND e.published_generation<>? AND ${eligible})`;
    const args=[lock.owner,row.email_id,row.delivery_id,row.published_generation,state.generation];
    // Retire references BEFORE deleting objects. A backup between GC passes
    // must never export an attachment reference whose bytes were just erased.
    // The durable generation cursor, not a stale attachment row, is the retry job.
    await db.batch([
      db.prepare(`DELETE FROM attachments WHERE email_id=? AND generation=?
        ${keys?'AND key IN (SELECT value FROM json_each(?))':''} AND ${gate}`)
        .bind(row.email_id,state.generation,...(keys?[JSON.stringify(keys)]:[]),...args),
      db.prepare(`SELECT CASE WHEN ${gate} THEN 1 ELSE json('GENERATION_GC_GUARD_LOST') END`).bind(...args),
    ]);
  }
  function pageValid(page) {
    if(!page||!Array.isArray(page.objects)||!Array.isArray(page.delimitedPrefixes)||
      typeof page.truncated!=='boolean'||page.objects.length+page.delimitedPrefixes.length>LIMIT||
      page.truncated&&(typeof page.cursor!=='string'||!page.cursor||page.cursor===state.continuation))fail();
  }
  try {
    await db.prepare('INSERT OR IGNORE INTO recovery_cursors(job_name) VALUES (?)').bind(JOB).run();
    const saved=await db.prepare(`SELECT cursor,next_run_at,${NOW} AS db_now FROM recovery_cursors WHERE job_name=?`).bind(JOB).first();
    if(saved.next_run_at>saved.db_now)return {backoff:true};
    state=decode(saved.cursor);
    row=await db.prepare(`SELECT e.email_id,e.delivery_id,e.published_generation,e.html_r2_key,e.text_r2_key,
      CASE WHEN ${eligible} THEN 1 ELSE 0 END AS eligible FROM email e
      LEFT JOIN mail_processing p ON p.delivery_id=e.delivery_id
      WHERE ${state.email===null ? 'e.email_id>?':'e.email_id=?'} ORDER BY e.email_id LIMIT 1`)
      .bind(state.email??state.after).first();
    if(!row){await save(fresh(state.email??0));return {idle:true};}
    if(!row.eligible){await save(fresh(row.email_id));return {skipped:true};}
    if(!UUID.test(row.delivery_id)||!HASH.test(row.published_generation)||
      row.html_r2_key!==`derived/${row.delivery_id}/${row.published_generation}/body.html`||
      row.text_r2_key!==`derived/${row.delivery_id}/${row.published_generation}/body.txt`)fail();
    if(state.email===null)await save({...state,email:row.email_id});
    if(state.generation===row.published_generation){
      // Reprocessing may publish a formerly old generation between invocations.
      await save({...state,generation:null,kind:0,continuation:null});return {changed:true};
    }
    if(state.generation===null){
      const prefix=`${KINDS[state.kind]}/${row.delivery_id}/`;
      const page=await r2.list({prefix,delimiter:'/',limit:LIMIT,
        ...(state.continuation?{cursor:state.continuation}:{})});
      pageValid(page);
      if(page.objects.length)fail();
      const generations=page.delimitedPrefixes.map(value=>{
        if(typeof value!=='string'||!value.startsWith(prefix)||!value.endsWith('/'))fail();
        const generation=value.slice(prefix.length,-1);if(!HASH.test(generation))fail();return generation;
      });
      const generation=generations.find(value=>value!==row.published_generation);
      if(generation)await save({...state,generation,kind:0,continuation:null});
      else if(page.truncated){await save({...state,continuation:page.cursor});return {scanning:true};}
      else if(state.kind<2){await save({...state,kind:state.kind+1,continuation:null});return {scanning:true};}
      else {
        // R2 may already be empty after an interrupted cleanup. Finalize stale
        // staging rows through the same guarded empty-prefix check.
        const stale=await db.prepare(`SELECT generation FROM attachments WHERE email_id=?
          AND generation IS NOT NULL AND generation<>? ORDER BY generation LIMIT 1`)
          .bind(row.email_id,row.published_generation).first();
        if(!stale){await save(fresh(row.email_id));return {complete:true};}
        if(!HASH.test(stale.generation))fail();
        await save({...state,generation:stale.generation,kind:0,continuation:null});
      }
    }
    const prefixes=KINDS.map(kind=>`${kind}/${row.delivery_id}/${state.generation}/`);
    for(const [index,prefix] of prefixes.entries()){
      const page=await r2.list({prefix,limit:LIMIT,include:['customMetadata']});
      pageValid(page);
      if(page.delimitedPrefixes.length||page.truncated&&!page.objects.length)fail();
      const keys=page.objects.map(object=>{
        const suffix=typeof object.key==='string'&&object.key.startsWith(prefix)?object.key.slice(prefix.length):'';
        if(!(index===0 ? /^(body\.html|body\.txt|manifest\.json)$/.test(suffix):/^part-[1-9]\d*$/.test(suffix))||
          object.customMetadata?.deliveryId!==row.delivery_id||object.customMetadata?.generation!==state.generation)fail();
        return object.key;
      });
      if(new Set(keys).size!==keys.length)fail();
      if(!keys.length)continue;
      await current();
      const referenced=await db.prepare(`SELECT 1 FROM attachments a WHERE a.key IN (SELECT value FROM json_each(?))
        AND (a.email_id<>? OR a.generation IS NOT ? OR a.storage_version IS NOT 'r2-v1' OR a.storage_backend IS NOT 'r2') LIMIT 1`)
        .bind(JSON.stringify(keys),row.email_id,state.generation).first();
      if(referenced)fail();
      await current();
      await retireIndices(keys);
      await current();
      await r2.delete(keys);
      // Await storage completion before releasing PURGE. Restart at the prefix
      // start; no listing cursor is reused after deletion.
      return {deleted:keys.length,complete:false};
    }
    await current();
    // D1 limits LIKE/GLOB pattern length; namespace paths exceed that limit.
    // Compare complete keys literally and apply short patterns only to part IDs.
    const invalidRow=await db.prepare(`SELECT 1 FROM attachments WHERE email_id=? AND generation=?
      AND (storage_version IS NOT 'r2-v1' OR storage_backend IS NOT 'r2'
        OR part_id IS NULL OR part_id NOT GLOB 'part-[1-9]*' OR substr(part_id,6) GLOB '*[^0-9]*'
        OR (key IS NOT (?||part_id) AND key IS NOT (?||part_id))) LIMIT 1`)
      .bind(row.email_id,state.generation,prefixes[1],prefixes[2]).first();
    if(invalidRow)fail();
    await retireIndices();
    await db.prepare(`INSERT INTO operations_events(delivery_id,stage,code)
      SELECT ?,'GENERATION_GC','COLLECTED' WHERE ${lockGate}`).bind(row.delivery_id,lock.owner).run();
    await save({...state,generation:null,kind:0,continuation:null});
    return {generationComplete:true};
  }catch{
    await db.prepare(`UPDATE recovery_cursors SET invalid_count=invalid_count+1,next_run_at=${NOW}+60000,
      updated_at=${NOW} WHERE job_name=? AND ${lockGate}`).bind(JOB,lock.owner).run();
    return {retry:true};
  }finally{await releaseStorageLock(db,lock);}
}
