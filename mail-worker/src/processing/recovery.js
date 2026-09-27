import { describeRawObject } from './queue-event.js';

const DAY=86400000;
const nowSql='(unixepoch()*1000)';
const undeleted=`NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=p.delivery_id)
  AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=p.delivery_id)`;
const message=(deliveryId,rawKey)=>({body:{version:1,kind:'process',deliveryId,rawKey},contentType:'json'});

export async function recoverMail(env) {
  if (!env.MAIL_QUEUE?.sendBatch || !env.r2?.list) throw new Error('RECOVERY_UNCONFIGURED');
  const db=env.db,owner=crypto.randomUUID();
  let lock;
  try {
    await db.batch(['dispatcher','recent','history'].map(name=>db.prepare('INSERT OR IGNORE INTO recovery_cursors(job_name) VALUES (?)').bind(name)));
    lock=await db.prepare(`UPDATE recovery_cursors SET lease_owner=?,lease_epoch=lease_epoch+1,
      lease_until=${nowSql}+1200000,updated_at=${nowSql}
      WHERE job_name='dispatcher' AND lease_until<=${nowSql} RETURNING *`).bind(owner).first();
    if (!lock) return {busy:true};
    const now=lock.updated_at;
    const due=(await db.prepare(`SELECT delivery_id,raw_key FROM (
      SELECT * FROM (SELECT delivery_id,raw_key,updated_at FROM mail_processing p
        WHERE state IN ('RECEIVED','QUEUED','RETRY_WAIT') AND next_attempt_at<=${nowSql} AND attempts<6 AND ${undeleted}
        ORDER BY next_attempt_at LIMIT 10)
      UNION ALL
      SELECT * FROM (SELECT delivery_id,raw_key,updated_at FROM mail_processing p
        WHERE state='PROCESSING' AND lease_until<=${nowSql} AND ${undeleted} ORDER BY lease_until LIMIT 10)
    ) ORDER BY updated_at LIMIT 10`).all()).results;
    if (due.length) await env.MAIL_QUEUE.sendBatch(due.map(row=>message(row.delivery_id,row.raw_key)));
    const cursors=(await db.prepare("SELECT * FROM recovery_cursors WHERE job_name IN ('recent','history')").all()).results;
    const history=cursors.find(row=>row.job_name==='history');
    const scan=history.next_run_at<=now ? history:cursors.find(row=>row.job_name==='recent');
    const day=Math.floor(now/DAY)*DAY;
    const start=Math.floor((now-3*DAY)/DAY)*DAY;
    const partition=scan.partition_at || start;
    const prefix=scan.job_name==='history' ? 'raw/':`raw/${new Date(partition).toISOString().slice(0,10).replaceAll('-','/')}/`;
    const page=await env.r2.list({prefix,limit:100,include:['customMetadata'],...(scan.cursor ? {cursor:scan.cursor}:{})});
    if (page.truncated && !page.cursor) throw new Error('INVALID_RECOVERY_PAGE');
    const candidates=[];
    let invalid=0;
    for (const object of page.objects) {
      try {
        const raw=describeRawObject(object,{rawKey:object.key,deliveryId:object.customMetadata?.deliveryId});
        candidates.push(raw);
      } catch { invalid++; }
    }
    const excluded=new Set((await db.prepare(`SELECT j.value AS id FROM json_each(?) j WHERE
      EXISTS(SELECT 1 FROM mail_processing p WHERE p.delivery_id=j.value) OR
      EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=j.value) OR
      EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=j.value)`)
      .bind(JSON.stringify(candidates.map(raw=>raw.deliveryId))).all()).results.map(row=>row.id));
    const orphans=candidates.filter(raw=>!excluded.has(raw.deliveryId));
    if (orphans.length) await env.MAIL_QUEUE.sendBatch(orphans.map(raw=>message(raw.deliveryId,raw.rawKey)));
    const nextPartition=page.truncated ? partition:partition+DAY>day ? start:partition+DAY;
    const nextWindow=scan.job_name==='recent' && !page.truncated && partition+DAY>day ? start:(scan.window_start || start);
    const nextRun=scan.job_name==='history' ? now+(page.truncated ? 30*60000:7*DAY):0;
    // Advance only after successful sends. Stale dispatchers cannot overwrite progress.
    const update=await db.prepare(`UPDATE recovery_cursors SET prefix=?,cursor=?,partition_at=?,window_start=?,
      next_run_at=?,invalid_count=invalid_count+?,updated_at=${nowSql} WHERE job_name=?
      AND EXISTS(SELECT 1 FROM recovery_cursors l WHERE l.job_name='dispatcher' AND l.lease_owner=?
        AND l.lease_epoch=? AND l.lease_until>${nowSql})`)
      .bind(prefix,page.truncated ? page.cursor:null,nextPartition,nextWindow,nextRun,invalid,scan.job_name,owner,lock.lease_epoch).run();
    if (update.meta.changes!==1) throw new Error('RECOVERY_LEASE_LOST');
    return {due:due.length,orphans:orphans.length,invalid,scan:scan.job_name};
  } catch { throw new Error('RECOVERY_UNAVAILABLE'); }
  finally {
    if (lock) {
      try { await db.prepare("UPDATE recovery_cursors SET lease_owner=NULL,lease_until=0 WHERE job_name='dispatcher' AND lease_owner=? AND lease_epoch=?")
        .bind(owner,lock.lease_epoch).run(); }
      catch { throw new Error('RECOVERY_UNAVAILABLE'); }
    }
  }
}
