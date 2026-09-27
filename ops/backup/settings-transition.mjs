// Offline operator tooling only. Never import this module into an HTTP handler.
import {createHash,randomUUID} from 'node:crypto';
import {Writable} from 'node:stream';
import {encryptBlob,decryptBlob} from './age-stream.mjs';
import {legacyStorageConfig} from '../../mail-worker/src/vps/legacy-config.js';

const LIMIT=1024*1024;
const cleared=['secret_key','site_key','tg_bot_token','tg_chat_id','forward_email','rule_email',
  's3_access_key','s3_secret_key','bucket','region','endpoint','custom_domain','r2_domain',
  'linuxdo_client_id','linuxdo_client_secret','github_client_id','github_client_secret',
  'google_client_id','google_client_secret','webhook_url','webhook_secret'];
const disabled=['register','send','register_verify','add_email_verify','forward_status','tg_bot_status',
  'webhook_status','linuxdo_switch','github_switch','google_switch','ai_code','no_recipient'];
const replacement=Object.fromEntries([...cleared.map(name=>[name,'']),...disabled.map(name=>[name,1]),['resend_tokens','{}']]);
const columns=[...Object.keys(replacement),'force_path_style'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw new Error(code);};

function checkedSource(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...columns].sort().join())fail('SETTINGS_SOURCE_INVALID');
  const row=Object.fromEntries(columns.map(name=>[name,value[name]]));
  if(Object.values(row).some(value=>value!==null&&typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)))||
    Object.values(row).some(value=>typeof value==='string'&&(!value.isWellFormed()||value.length>65536))||Buffer.byteLength(JSON.stringify(row))>LIMIT/2)
    fail('SETTINGS_SOURCE_INVALID');
  return row;
}
async function source(db){
  const rows=(await db.prepare(`SELECT ${columns.map(name=>'"'+name+'"').join(',')} FROM setting LIMIT 2`).all()).results;
  if(rows.length!==1)fail('SETTINGS_SINGLETON_REQUIRED');
  return checkedSource(rows[0]);
}
async function cache(kv){
  const value=await kv.get('setting:');
  if(value!==null&&(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>LIMIT/4))fail('SETTINGS_CACHE_INVALID');
  return value;
}
function environment(row,backend){
  if(!['kv','r2','s3'].includes(backend))fail('SETTINGS_BACKEND_REQUIRED');
  if(backend!=='s3'&&![row.endpoint,row.bucket,row.s3_access_key,row.s3_secret_key].some(Boolean))return {LEGACY_MAIL_STORAGE:backend};
  // Do not silently rewrite a provider endpoint or change its addressing mode.
  if(![0,1].includes(row.force_path_style))fail('SETTINGS_S3_PATH_STYLE_UNSUPPORTED');
  return legacyStorageConfig({LEGACY_MAIL_STORAGE:backend,LEGACY_S3_FORCE_PATH_STYLE:row.force_path_style===0?'true':'false',LEGACY_S3_ENDPOINT:row.endpoint,LEGACY_S3_BUCKET:row.bucket,
    LEGACY_S3_REGION:row.region||'auto',LEGACY_S3_ACCESS_KEY_ID:row.s3_access_key,LEGACY_S3_SECRET_ACCESS_KEY:row.s3_secret_key});
}
function sourceGuards(db,row){
  return db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM setting)=1 AND EXISTS(SELECT 1 FROM setting WHERE ${columns.map(name=>'"'+name+'" IS ?').join(' AND ')})
    THEN 1 ELSE json('SETTINGS_SOURCE_CHANGED') END`).bind(...columns.map(name=>row[name]));
}
export async function inspectSettingsTransition(db,{backend}={}){
  const row=await source(db);
  environment(row,backend);
  return {backend,fieldsToClear:cleared.filter(name=>row[name]!==null&&row[name]!=='').length,
    changesRequired:Object.entries(replacement).some(([name,value])=>row[name]!==value)};
}
export async function prepareSettingsTransition({db,kv,backend,...age}){
  const row=await source(db),env=environment(row,backend);
  const payload={version:1,kind:'cloud-mail-settings-transition',id:randomUUID(),backend,source:row,environment:env,cache:await cache(kv)};
  const bytes=Buffer.from(JSON.stringify(payload));
  try {
    const blob=await encryptBlob({...age,source:[bytes],maxBytes:LIMIT});
    return {version:1,kind:'cloud-mail-settings-transition',blob};
  } finally {bytes.fill(0);}
}
export async function readSettingsTransition({receipt,...age}){
  if(receipt?.version!==1||receipt?.kind!=='cloud-mail-settings-transition'||
    !Number.isSafeInteger(receipt.blob?.plain?.size)||receipt.blob.plain.size<1||receipt.blob.plain.size>LIMIT||
    !Number.isSafeInteger(receipt.blob?.cipher?.size)||receipt.blob.cipher.size<1||receipt.blob.cipher.size>LIMIT+131072)
    fail('SETTINGS_ARCHIVE_INVALID');
  const chunks=[];
  try {
    await decryptBlob({...age,blob:receipt.blob,destination:new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}})});
    const bytes=Buffer.concat(chunks);let payload;
    try{payload=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
    if(payload?.version!==1||payload?.kind!==receipt.kind||!/^[a-f0-9-]{36}$/.test(payload.id))fail('SETTINGS_ARCHIVE_INVALID');
    payload.source=checkedSource(payload.source);
    if(payload.cache!==null&&(typeof payload.cache!=='string'||!payload.cache.isWellFormed()||Buffer.byteLength(payload.cache)>LIMIT/4))fail('SETTINGS_ARCHIVE_INVALID');
    const expected=environment(payload.source,payload.backend);
    if(hash(expected)!==hash(payload.environment))fail('SETTINGS_ARCHIVE_INVALID');
    return payload;
  } finally {for(const bytes of chunks)bytes.fill(0);}
}
export async function applySettingsTransition({db,kv,writersStopped,runtimeEnvironment,...archive}){
  if(writersStopped!==true)fail('SETTINGS_OFFLINE_REQUIRED');
  // A decryptable archive and provisioned credentials are prerequisites to any mutation.
  const payload=await readSettingsTransition(archive),row=await source(db);
  const actual=legacyStorageConfig(runtimeEnvironment??{});
  if(Object.entries(payload.environment).some(([name,value])=>actual[name]!==value))fail('SETTINGS_ENVIRONMENT_MISMATCH');
  const target={...payload.source,...replacement};
  let alreadyApplied=false;
  if(hash(row)===hash(target)){
    const prior=await db.prepare("SELECT 1 FROM audit_logs WHERE action='setting.secrets-migrated' AND target_id=? AND result_code='LOCAL_ARCHIVE_VERIFIED'").bind(payload.id).first();
    alreadyApplied=!!prior;
  }
  if(!alreadyApplied&&hash(row)!==hash(payload.source))fail('SETTINGS_SOURCE_CHANGED');
  const oldCache=await cache(kv);
  if(oldCache!==payload.cache&&!(alreadyApplied&&oldCache===null))fail('SETTINGS_CACHE_CHANGED');
  if(!alreadyApplied)try {
    await db.batch([
      sourceGuards(db,payload.source),
      db.prepare('UPDATE setting SET '+Object.keys(replacement).map(name=>'"'+name+'"=?').join(',')).bind(...Object.values(replacement)),
      db.prepare("INSERT INTO audit_logs(action,target_id,result_code,created_at) VALUES('setting.secrets-migrated',?,'LOCAL_ARCHIVE_VERIFIED',?)")
        .bind(payload.id,Date.now()),
    ]);
  }catch{fail('SETTINGS_TRANSACTION_FAILED');}
  // D1 and KV cannot commit atomically. After a verified DB commit, a retry of
  // this exact archive can finish cache removal without changing settings again.
  if(oldCache!==null){
    if(await cache(kv)!==oldCache)fail('SETTINGS_CACHE_CHANGED');
    try{await kv.delete('setting:');if(await cache(kv)!==null)fail('SETTINGS_CACHE_REMAINS');}
    catch{fail('SETTINGS_CACHE_CLEANUP_FAILED');}
  }
  return {changed:!alreadyApplied,cacheCleared:oldCache!==null};
}
