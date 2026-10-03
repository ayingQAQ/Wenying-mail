import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,chmodSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const fail=()=>new Error('LOCAL_DB_UNAVAILABLE');
function binding(value){
 if(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return value;
 if(value instanceof ArrayBuffer)return Buffer.from(new Uint8Array(value));
 if(ArrayBuffer.isView(value))return Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
 throw new Error('D1_INVALID_BINDING');
}
// D1-compatible surface keeps Hono/Drizzle and transaction fences unchanged.
// Local storage is opt-in; never silently create a replacement production DB.
export function localD1({path,create=true,admission}){
 if(typeof path!=='string'||path!==':memory:'&&!isAbsolute(path))throw new Error('INVALID_LOCAL_DB_PATH');
 if(path!==':memory:'){
  try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw fail();}
  catch(error){if(error.code!=='ENOENT'||!create)throw fail();const fd=openSync(path,'wx',0o600);closeSync(fd);}
  chmodSync(path,0o600);
 }
 const database=new DatabaseSync(path,{enableForeignKeyConstraints:true});
 if(!create){
  const tables=new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name));
  if(['schema_migrations','user','account','sessions','email','mail_tombstones','mail_processing','domains','setting'].some(name=>!tables.has(name))){database.close();throw new Error('LOCAL_DB_SCHEMA_MISSING');}
 }
 database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
 return adaptLocalDatabase(database,{admission});
}
export function adaptLocalDatabase(database,{admission}={}){
 const owned=new WeakSet();let closed=false,queue=Promise.resolve();
 if(admission)database.exec(`CREATE TABLE IF NOT EXISTS _vps_admission_sync(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER,payload TEXT,pending INTEGER NOT NULL DEFAULT 1);
  INSERT OR IGNORE INTO _vps_admission_sync(singleton) VALUES(1);`);
 const desired=()=>database.prepare(`SELECT lower(a.email) AS email,a.account_id AS accountId,a.user_id AS userId
   FROM account a JOIN user u ON u.user_id=a.user_id JOIN domains d ON d.domain_id=a.domain_id
   WHERE a.is_del=0 AND a.retired_at IS NULL AND a.receive_enabled=1 AND u.is_del=0 AND u.retired_at IS NULL
    AND u.status=0 AND d.enabled=1 AND d.name=substr(a.email,instr(a.email,'@')+1) COLLATE NOCASE ORDER BY lower(a.email)`).all();
 const pending=()=>!!admission&&database.prepare('SELECT pending FROM _vps_admission_sync WHERE singleton=1').get().pending===1;
 const record=token=>database.prepare('UPDATE _vps_admission_sync SET revision=?,payload=?,pending=1 WHERE singleton=1').run(token.revision,token.payload);
 const complete=async token=>{await admission.publish(token);database.prepare('UPDATE _vps_admission_sync SET pending=0 WHERE singleton=1 AND revision=?').run(token.revision);};
 const serial=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
 const mapped=v=>({success:true,meta:v.meta,results:v.rows.map(row=>Object.fromEntries(v.columns.map((name,i)=>[name,row[i]])))});
 async function executeNow(statements){
  if(closed||!Array.isArray(statements)||!statements.length||statements.length>100||statements.some(s=>!owned.has(s)))throw fail();
  let started=false,synchronizing=false;
  try{
   database.exec('BEGIN IMMEDIATE');started=true;
   const checkAdmission=!!admission&&statements.some(s=>/^\s*(WITH|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s.sql)&&/\b(account|user|domains)\b/i.test(s.sql));
   const original=checkAdmission?JSON.stringify(desired()):undefined;
   const values=statements.map(s=>{
    const sql=s.sql.trim().replace(/;$/,'');
    // The application supplies SQL; callers only supply bound parameters.
    // Reject extra statements and transaction/attachment/pragma controls.
    if(sql.includes(';')||! /^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql))throw fail();
    const before=database.prepare('SELECT total_changes() AS n').get().n;
    const statement=database.prepare(sql),columns=statement.columns().map(c=>c.name);statement.setReturnArrays(true);
    const rows=statement.all(...s.params).map(row=>row.map(v=>{
     if(v instanceof Uint8Array)return Array.from(v);
     if(v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)))return v;
     throw fail();
    }));
    const changed=database.prepare('SELECT total_changes() AS n').get().n-before;
    // Count the top-level statement, not trigger/cascade work. SELECT must not
    // inherit the previous write's changes(), which breaks publication fences.
    const changes=changed?database.prepare('SELECT changes() AS n').get().n:0;
    const last=database.prepare('SELECT last_insert_rowid() AS n').get().n;
    return {columns,rows,meta:{changes,last_row_id:last,served_by_primary:true}};
   });
   let token;
   if(checkAdmission){const rows=desired();if(JSON.stringify(rows)!==original){synchronizing=true;token=await admission.prepare(rows);record(token);}}
   database.exec('COMMIT');started=false;
   if(token)await complete(token);
   return values;
  }catch{
   if(started)try{database.exec('ROLLBACK');}catch{}
   // A lost HTTP response can have disabled an edge entry even when the local
   // transaction rolls back. Persist repair intent for the next reconciliation.
   if(synchronizing)try{database.prepare('UPDATE _vps_admission_sync SET pending=1 WHERE singleton=1').run();}catch{}
   throw fail();
  }
 }
 const execute=statements=>serial(()=>executeNow(statements));
 function prepare(sql,params=[]){
  if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>100000)throw new Error('D1_INVALID_SQL');
  const statement={sql,params,
   bind(...values){return prepare(sql,values.map(binding));},
   async all(){return mapped((await execute([statement]))[0]);},
   async run(){return statement.all();},
   async first(column){const row=(await statement.all()).results[0];if(!row)return null;if(column===undefined)return row;if(!Object.hasOwn(row,column))throw fail();return row[column];},
   async raw({columnNames=false}={}){const value=(await execute([statement]))[0];return columnNames?[value.columns,...value.rows]:value.rows;},
  };Object.freeze(params);Object.freeze(statement);owned.add(statement);return statement;
 }
 return {prepare,batch:async statements=>(await execute(statements)).map(mapped),admissionPending:pending,
  reconcileAdmission:()=>serial(async()=>{if(!admission||!pending())return;const token=await admission.prepare(desired());record(token);await complete(token);}),
  close(){if(!closed){closed=true;database.close();}}};
}
