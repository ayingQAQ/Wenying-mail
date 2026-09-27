const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validOffsiteReceipt(input) {
  const fields=['action','phase','attemptId','snapshotId','manifestHash','targetHash',...(input.phase==='COMPLETE'?['catalogHash']:[])];
  return Object.keys(input).sort().join(',')===fields.sort().join(',')&&['PENDING','COMPLETE','FAILED'].includes(input.phase)&&
    uuid.test(input.attemptId)&&uuid.test(input.snapshotId)&&/^[a-f0-9]{64}$/.test(input.manifestHash)&&/^[a-f0-9]{64}$/.test(input.targetHash)&&
    (input.phase!=='COMPLETE'||/^[a-f0-9]{64}$/.test(input.catalogHash));
}
export async function recordOffsiteReceipt(db,input) {
  if(input.phase==='PENDING')await db.batch([
    db.prepare(`INSERT INTO backup_offsite_runs(attempt_id,backup_id,target_hash,state)
      SELECT ?,backup_id,?,'PENDING' FROM backup_runs WHERE state='COMPLETE' AND snapshot_id=? AND manifest_hash=?
        AND (SELECT count(*) FROM backup_runs WHERE state='COMPLETE' AND snapshot_id=? AND manifest_hash=?)=1
      ON CONFLICT(attempt_id) DO NOTHING`).bind(input.attemptId,input.targetHash,input.snapshotId,input.manifestHash,input.snapshotId,input.manifestHash),
    db.prepare("INSERT INTO audit_logs(action,target_id,result_code,created_at) SELECT 'backup.offsite',?,'PENDING',unixepoch()*1000 WHERE changes()=1").bind(input.attemptId),
  ]);
  const row=await db.prepare(`SELECT t.*,b.snapshot_id,b.manifest_hash FROM backup_offsite_runs t JOIN backup_runs b ON b.backup_id=t.backup_id WHERE t.attempt_id=? AND b.state='COMPLETE'`).bind(input.attemptId).first();
  if(!row||row.target_hash!==input.targetHash||row.snapshot_id!==input.snapshotId||row.manifest_hash!==input.manifestHash)return false;
  if(row.state===input.phase)return input.phase!=='COMPLETE'||row.catalog_hash===input.catalogHash;
  if(input.phase==='PENDING'||row.state!=='PENDING')return false;
  await db.batch([
    db.prepare("UPDATE backup_offsite_runs SET state=?,catalog_hash=?,updated_at=unixepoch()*1000 WHERE attempt_id=? AND state='PENDING'").bind(input.phase,input.catalogHash??null,input.attemptId),
    db.prepare("INSERT INTO audit_logs(action,target_id,result_code,created_at) SELECT 'backup.offsite',?,?,unixepoch()*1000 WHERE changes()=1").bind(input.attemptId,input.phase),
  ]);
  const latest=await db.prepare('SELECT state,catalog_hash FROM backup_offsite_runs WHERE attempt_id=?').bind(input.attemptId).first();
  return latest.state===input.phase&&(input.phase!=='COMPLETE'||latest.catalog_hash===input.catalogHash);
}
