const now='unixepoch()*1000';

export async function acquireStorageLock(db,kind) {
  if(!['PURGE','BACKUP'].includes(kind)) throw new Error('INVALID_STORAGE_LOCK');
  const owner=crypto.randomUUID();
  // Never steal a PURGE lock on timeout: an old R2 operation may still be in
  // flight. An abandoned purge requires operator/runtime quiescence evidence.
  return db.prepare(`UPDATE storage_maintenance SET kind=?,owner=?,expires_at=${now}+?,updated_at=${now}
    WHERE singleton=1 AND (kind='IDLE' OR (kind='BACKUP' AND expires_at<=${now})) RETURNING kind,owner,expires_at`)
    .bind(kind,owner,kind==='BACKUP'?1800000:1200000).first();
}
export async function assertStorageLock(db,lock) {
  const row=await db.prepare(`SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind=? AND owner=? AND expires_at>${now}`)
    .bind(lock.kind,lock.owner).first();
  if(!row) throw new Error('STORAGE_LOCK_LOST');
}
export async function renewBackupHold(db,lock) {
  if(lock.kind!=='BACKUP') throw new Error('INVALID_STORAGE_LOCK');
  const result=await db.prepare(`UPDATE storage_maintenance SET expires_at=${now}+1800000,updated_at=${now}
    WHERE singleton=1 AND kind='BACKUP' AND owner=? AND expires_at>${now}`).bind(lock.owner).run();
  if(result.meta.changes!==1) throw new Error('BACKUP_HOLD_EXPIRED');
}
export async function releaseStorageLock(db,lock) {
  await db.prepare(`UPDATE storage_maintenance SET kind='IDLE',owner=NULL,expires_at=0,updated_at=${now}
    WHERE singleton=1 AND kind=? AND owner=?`).bind(lock.kind,lock.owner).run();
}
