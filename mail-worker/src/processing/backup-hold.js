import {verifyAccess} from '../security/access.js';
import {acquireStorageLock,assertStorageLock,renewBackupHold,releaseStorageLock} from './storage-lock.js';
import {validOffsiteReceipt,recordOffsiteReceipt} from './backup-offsite.js';

const response=(code,status=200,extra={})=>Response.json({code,...extra},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function backupHold(request,env) {
  if(typeof env.BACKUP_ACCESS_AUD!=='string' || !env.BACKUP_ACCESS_AUD.trim() ||
    typeof env.BACKUP_ACCESS_CLIENT_ID!=='string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(env.BACKUP_ACCESS_CLIENT_ID))
    return response('BACKUP_NOT_CONFIGURED',503);
  const access=await verifyAccess(request,{...env,ACCESS_AUD:env.BACKUP_ACCESS_AUD},env.BACKUP_ACCESS_CLIENT_ID);
  if(access.response) return access.response;
  if(request.method!=='POST') return response('METHOD_NOT_ALLOWED',405);
  // Service-only API: reject browser credential contexts, even with a valid assertion.
  if(request.headers.has('Origin') || request.headers.has('Cookie')) return response('SERVICE_REQUEST_REQUIRED',403);
  let input;
  try {
    if(!request.headers.get('Content-Type')?.startsWith('application/json')) return response('INVALID_REQUEST',400);
    const reader=request.body?.getReader();if(!reader) return response('INVALID_REQUEST',400);
    const chunks=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>512){await reader.cancel();return response('INVALID_REQUEST',400);}chunks.push(value);}}
    finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    input=JSON.parse(new TextDecoder().decode(bytes));
    if(!input || !['acquire','renew','assert','release','complete','fail','offsite'].includes(input.action)) return response('INVALID_REQUEST',400);
    if(input.action==='offsite'&&!validOffsiteReceipt(input))return response('INVALID_REQUEST',400);
    if(!['acquire','offsite'].includes(input.action) && !/^[a-f0-9-]{36}$/.test(input.owner || '')) return response('INVALID_REQUEST',400);
  } catch {return response('INVALID_REQUEST',400);}
  try {
    if(input.action==='offsite')return await recordOffsiteReceipt(env.db,input)?response('OFFSITE_RECORDED'):response('BACKUP_STATE_CHANGED',409);
    if(input.action==='complete'||input.action==='fail') {
      if(input.action==='complete'&&(!/^[a-f0-9-]{36}$/.test(input.snapshotId||'')||!/^[a-f0-9]{64}$/.test(input.manifestHash||'')||!Number.isSafeInteger(input.snapshotAt)||input.snapshotAt<0||input.snapshotAt>Date.now()))return response('INVALID_REQUEST',400);
      const changed=await env.db.prepare(`UPDATE backup_runs SET state=?,snapshot_id=?,snapshot_at=?,manifest_hash=?,completed_at=unixepoch()*1000,error_code=?
        WHERE backup_id=? AND state IN ('RUNNING','COPIED') AND (?='FAILED' OR (state='COPIED' AND hold_until>unixepoch()*1000))`)
        .bind(input.action==='complete'?'COMPLETE':'FAILED',input.action==='complete'?input.snapshotId:null,input.action==='complete'?input.snapshotAt:null,input.action==='complete'?input.manifestHash:null,input.action==='fail'?'RUNNER_FAILED':null,input.owner,input.action==='fail'?'FAILED':'COMPLETE').run();
      return changed.meta.changes===1?response('BACKUP_RECORDED'):response('BACKUP_STATE_CHANGED',409);
    }
    if(input.action==='acquire') {
      const lock=await acquireStorageLock(env.db,'BACKUP');
      if(lock)try{await env.db.prepare("INSERT INTO backup_runs(backup_id,state,hold_until,started_at) VALUES(?,'RUNNING',?,unixepoch()*1000)").bind(lock.owner,lock.expires_at).run();}
      catch(error){await releaseStorageLock(env.db,lock);throw error;}
      return lock ? response('BACKUP_HELD',200,{owner:lock.owner,expiresAt:lock.expires_at}) : response('STORAGE_BUSY',409);
    }
    const lock={kind:'BACKUP',owner:input.owner};
    if(input.action==='release') {
      await env.db.batch([
        env.db.prepare(`UPDATE backup_runs SET state='COPIED' WHERE backup_id=? AND state='RUNNING' AND EXISTS
          (SELECT 1 FROM storage_maintenance WHERE kind='BACKUP' AND owner=? AND expires_at>unixepoch()*1000)`).bind(lock.owner,lock.owner),
        env.db.prepare("UPDATE storage_maintenance SET kind='IDLE',owner=NULL,expires_at=0,updated_at=unixepoch()*1000 WHERE kind='BACKUP' AND owner=?").bind(lock.owner),
      ]);return response('BACKUP_RELEASED');
    }
    await assertStorageLock(env.db,lock);
    if(input.action==='renew') {
      await renewBackupHold(env.db,lock);
      await env.db.prepare("UPDATE backup_runs SET hold_until=(SELECT expires_at FROM storage_maintenance WHERE kind='BACKUP' AND owner=?) WHERE backup_id=? AND state='RUNNING'").bind(lock.owner,lock.owner).run();
    }
    const row=await env.db.prepare("SELECT expires_at FROM storage_maintenance WHERE singleton=1 AND kind='BACKUP' AND owner=? AND expires_at>unixepoch()*1000").bind(lock.owner).first();
    return row ? response('BACKUP_HELD',200,{owner:lock.owner,expiresAt:row.expires_at}):response('BACKUP_HOLD_LOST',409);
  } catch(error) {
    return ['STORAGE_LOCK_LOST','BACKUP_HOLD_EXPIRED'].includes(error.message) ? response('BACKUP_HOLD_LOST',409):response('BACKUP_UNAVAILABLE',503);
  }
}
