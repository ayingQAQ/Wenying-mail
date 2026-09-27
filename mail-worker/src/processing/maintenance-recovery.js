// Offline operator operation, never exposed as a web unlock button.
export async function releaseAbandonedPurge(db,{owner,quiescenceConfirmed}) {
  if(quiescenceConfirmed!==true||!/^[a-f0-9-]{36}$/.test(owner||''))throw new Error('QUIESCENCE_REQUIRED');
  const results=await db.batch([
    db.prepare("UPDATE storage_maintenance SET kind='IDLE',owner=NULL,expires_at=0,updated_at=unixepoch()*1000 WHERE kind='PURGE' AND owner=? AND expires_at<=unixepoch()*1000 RETURNING singleton").bind(owner),
    db.prepare("INSERT INTO audit_logs(action,target_id,result_code,created_at) SELECT 'maintenance.purge.released',?,'OPERATOR_CONFIRMED_QUIESCENCE',unixepoch()*1000 WHERE changes()=1").bind(owner),
  ]);
  if(!results[0].results.length)throw new Error('LOCK_STATE_CHANGED');
}
