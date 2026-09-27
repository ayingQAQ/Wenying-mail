import {DatabaseSync,constants} from 'node:sqlite';
import {assertTrustedSchema} from './database-contract.mjs';
import {backfillKey} from '../../mail-worker/src/processing/legacy-backfill-format.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const invalid=()=>{throw new Error('INVALID_DATABASE_SNAPSHOT');};
const snapshots=new WeakSet();
// This handle is always a new in-memory database, never an existing user DB.
// The complete runner must bound export bytes and execute inspection in a
// resource-limited subprocess before accepting SQL from an external archive.
export function openDatabaseSnapshot(sql,expectedSchema) {
  if(typeof sql!=='string'||Buffer.byteLength(sql)>512*1024*1024||!Array.isArray(expectedSchema)||!expectedSchema.length)invalid();
  const db=new DatabaseSync(':memory:',{allowExtension:false});
  db.exec('PRAGMA temp_store=MEMORY');
  db.setAuthorizer((action,arg1,arg2)=>{
    if([constants.SQLITE_ATTACH,constants.SQLITE_DETACH,constants.SQLITE_CREATE_VTABLE,constants.SQLITE_DROP_VTABLE].includes(action))return constants.SQLITE_DENY;
    if(action===constants.SQLITE_PRAGMA&&!['foreign_keys','defer_foreign_keys','table_info','integrity_check','quick_check'].includes(arg1))return constants.SQLITE_DENY;
    if(action===constants.SQLITE_FUNCTION&&!['count','coalesce','typeof','length','json','datetime','current_timestamp','unixepoch','lower','substr','instr','hex','printf','glob','like'].includes(arg2))return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
  try {
    db.exec(sql);
    const actual=db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    if(actual.length!==expectedSchema.length || actual.some((row,index)=>row.version!==expectedSchema[index].version || row.checksum!==expectedSchema[index].checksum))invalid();
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')invalid();
    assertTrustedSchema(db,expectedSchema);
    snapshots.add(db);return db;
  } catch {db.close();throw new Error('INVALID_DATABASE_SNAPSHOT');}
}

export function databaseReferences(db,{legacyBackend,maxObjects=1000000}={}) {
  if(!snapshots.has(db)||!Number.isSafeInteger(maxObjects)||maxObjects<1)invalid();
  const references=new Map();
  function add(backend,key,size=null,sha256=null) {
    if(!['r2','kv','s3'].includes(backend)||typeof key!=='string'||!key||key.length>1024||/[\x00-\x1f]/.test(key)||
      (size!==null&&(!Number.isSafeInteger(size)||size<0))||(sha256!==null&&!hash.test(sha256)))invalid();
    const id=JSON.stringify([backend,key]),prior=references.get(id);
    if(prior && ((prior.size!==null&&size!==null&&prior.size!==size)||(prior.sha256!==null&&sha256!==null&&prior.sha256!==sha256)))invalid();
    references.set(id,{backend,key,size:size??prior?.size??null,sha256:sha256??prior?.sha256??null});
    if(references.size>maxObjects)throw new Error('SNAPSHOT_REFERENCE_LIMIT');
  }
  // Read only reference fields: unrelated SQLite integers may exceed JavaScript's
  // safe range, and legacy bodies need not be materialized to enumerate objects.
  for(const row of db.prepare(`SELECT CASE WHEN storage_version='legacy-r2-v1' THEN email_id ELSE NULL END AS email_id,
    storage_version,delivery_id,published_generation,html_r2_key,text_r2_key,raw_r2_key,raw_size,raw_sha256
    FROM email WHERE delete_state='ACTIVE'`).iterate()) {
    if(row.storage_version==='legacy')continue;
    if(row.storage_version==='legacy-r2-v1'){
      if(row.delivery_id!==null||row.raw_r2_key!==null||row.published_generation!==null)invalid();
      const job=db.prepare("SELECT * FROM legacy_backfill_jobs WHERE email_id=? AND state='PUBLISHED'").get(row.email_id);
      const copies=db.prepare("SELECT part FROM legacy_backfill_objects WHERE email_id=? AND state='VERIFIED'").all(row.email_id);
      const parts=db.prepare('SELECT att_id FROM attachments WHERE email_id=?').all(row.email_id).map(att=>`att-${att.att_id}`);
      if(!job||job.object_count!==parts.length+2||copies.length!==job.object_count||
        ['html','text',...parts].some(part=>!copies.some(copy=>copy.part===part)))invalid();
      continue;
    }
    if(row.storage_version!=='r2-v1'||!uuid.test(row.delivery_id)||!hash.test(row.published_generation))invalid();
    const prefix=`derived/${row.delivery_id}/${row.published_generation}`;
    if(row.html_r2_key!==`${prefix}/body.html`||row.text_r2_key!==`${prefix}/body.txt`)invalid();
    if(!new RegExp(`^raw/\\d{4}/\\d{2}/\\d{2}/${row.delivery_id}\\.eml$`).test(row.raw_r2_key))invalid();
    add('r2',row.raw_r2_key,row.raw_size,row.raw_sha256);
    add('r2',row.html_r2_key);add('r2',row.text_r2_key);add('r2',`${prefix}/manifest.json`);
  }
  // Include verified copies from interrupted jobs too. Pending reservations are
  // resumable from retained originals, and may not have an object yet.
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legacy_backfill_objects'").get()){
    for(const row of db.prepare(`SELECT o.*,j.source_hash FROM legacy_backfill_objects o
      JOIN legacy_backfill_jobs j ON j.email_id=o.email_id JOIN email e ON e.email_id=o.email_id
      WHERE o.state='VERIFIED' AND e.delete_state='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=o.email_id)`).iterate()){
      if(row.key!==backfillKey(row.email_id,row.source_hash,row.part))invalid();
      add('r2',row.key,row.size,row.sha256);
    }
  }
  for(const row of db.prepare(`SELECT p.delivery_id,p.raw_key,p.raw_size FROM mail_processing p WHERE NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=p.delivery_id)
    AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=p.delivery_id)`).iterate()) {
    if(!uuid.test(row.delivery_id)||!new RegExp(`^raw/\\d{4}/\\d{2}/\\d{2}/${row.delivery_id}\\.eml$`).test(row.raw_key))invalid();
    add('r2',row.raw_key,row.raw_size);
  }
  for(const row of db.prepare(`SELECT a.storage_backend,a.storage_version,a.key,a.size,a.sha256 FROM attachments a
    WHERE NOT EXISTS(SELECT 1 FROM email e WHERE e.email_id=a.email_id AND e.delete_state<>'ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=a.email_id)`).iterate()) {
    const backend=row.storage_backend==='legacy'?legacyBackend:row.storage_backend;
    if(row.storage_version==='legacy'&&!/^attachments\/[A-Za-z0-9_.-]+$/.test(row.key))invalid();
    add(backend,row.key,row.size,row.sha256);
  }
  return [...references.values()];
}

export function prepareRestoredDatabase(db,latestLedger,{ledgerThrough,now=Date.now()}={}) {
  if(!snapshots.has(db)||!Array.isArray(latestLedger)||!Number.isSafeInteger(ledgerThrough)||ledgerThrough<0||!Number.isSafeInteger(now)||now<ledgerThrough)invalid();
  db.exec('BEGIN IMMEDIATE');
  try {
    const findTombstone=db.prepare('SELECT deleted_at,reason_code FROM mail_tombstones WHERE delivery_id=?');
    const insertTombstone=db.prepare('INSERT OR IGNORE INTO mail_tombstones(delivery_id,deleted_at,reason_code) VALUES (?,?,?)');
    for(const marker of latestLedger) {
      if(!marker||!(uuid.test(marker.deliveryId)||/^legacy-email-[1-9][0-9]*$/.test(marker.deliveryId))||
        !Number.isSafeInteger(marker.deletedAt)||marker.deletedAt<0||marker.deletedAt>now||
        !['USER_DELETE','TRASH_EXPIRED','IDENTITY_RETIRED'].includes(marker.reasonCode))invalid();
      const old=findTombstone.get(marker.deliveryId);
      if(old&&(old.deleted_at!==marker.deletedAt||old.reason_code!==marker.reasonCode))throw new Error('CONFLICTING_DELETION_LEDGER');
      insertTombstone.run(marker.deliveryId,marker.deletedAt,marker.reasonCode);
    }
    db.exec(`DELETE FROM sessions; DELETE FROM auth_attempts; DELETE FROM oauth; DELETE FROM reg_key; DELETE FROM verify_record;
      UPDATE setting SET secret_key='',site_key='',tg_bot_token='',resend_tokens='{}',s3_access_key='',s3_secret_key='',
        linuxdo_client_id='',linuxdo_client_secret='',github_client_id='',github_client_secret='',google_client_id='',google_client_secret='',webhook_secret='',webhook_url='',
        register=1,send=1,forward_status=1,tg_bot_status=1,webhook_status=1,linuxdo_switch=1,github_switch=1,google_switch=1,ai_code=1,auto_clean_days=0;
      UPDATE account SET receive_enabled=0;
      UPDATE domains SET enabled=0;
      UPDATE storage_maintenance SET kind='IDLE',owner=NULL,expires_at=0;
      DELETE FROM recovery_cursors;
      UPDATE email SET delete_state='DELETE_REQUESTED' WHERE EXISTS(SELECT 1 FROM mail_tombstones t
        WHERE t.delivery_id=email.delivery_id OR (email.storage_version IN ('legacy','legacy-r2-v1') AND t.delivery_id='legacy-email-'||email.email_id));
      UPDATE mail_processing SET lease_owner=NULL,lease_until=0,lease_epoch=lease_epoch+1;
      UPDATE mail_processing SET state='RECEIVED',attempts=0,parse_failures=0,retry_cycle=retry_cycle+1,next_attempt_at=0,last_error_code=NULL
        WHERE state IN ('RECEIVED','QUEUED','PROCESSING','RETRY_WAIT')
        AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=mail_processing.delivery_id)
        AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=mail_processing.delivery_id);
      UPDATE mail_deletion_jobs SET state='DELETE_REQUESTED',attempts=0,next_attempt_at=0,wait_until=0,last_error_code=NULL WHERE state<>'PURGED';`);
    db.prepare(`INSERT OR IGNORE INTO mail_deletion_jobs(delivery_id,email_id,state,requested_at,updated_at,user_id,account_id,raw_key,storage_version,wait_until)
      SELECT t.delivery_id,e.email_id,'DELETE_REQUESTED',t.deleted_at,?,e.user_id,e.account_id,e.raw_r2_key,e.storage_version,0
      FROM mail_tombstones t JOIN email e ON t.delivery_id=e.delivery_id OR (e.storage_version IN ('legacy','legacy-r2-v1') AND t.delivery_id='legacy-email-'||e.email_id)` ).run(now);
    db.prepare(`INSERT OR IGNORE INTO mail_deletion_jobs(delivery_id,email_id,state,requested_at,updated_at,user_id,account_id,raw_key,storage_version,wait_until)
      SELECT t.delivery_id,p.email_id,'DELETE_REQUESTED',t.deleted_at,?,p.user_id,p.account_id,p.raw_key,'r2-v1',0
      FROM mail_tombstones t JOIN mail_processing p ON t.delivery_id=p.delivery_id`).run(now);
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_runs'").get())db.exec("UPDATE backup_runs SET state='FAILED',error_code='RESTORED_RUN_INVALIDATED' WHERE state IN ('RUNNING','COPIED')");
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_offsite_runs'").get())db.exec("UPDATE backup_offsite_runs SET state='FAILED',updated_at=unixepoch()*1000 WHERE state='PENDING'");
    db.prepare(`INSERT INTO audit_logs(action,result_code,created_at) VALUES ('backup.restore.prepared','RECEIVING_DISABLED',?)`).run(now);
    db.exec('COMMIT');
    return {ledgerThrough,receivingEnabled:false,sessionsRestored:false};
  } catch(error) {db.exec('ROLLBACK');throw new Error(error.message==='CONFLICTING_DELETION_LEDGER'?error.message:'RESTORE_PREPARATION_FAILED');}
}

export function exportPreparedDatabase(db) {
  if(!snapshots.has(db))invalid();
  const identifier=name=>'"'+name.replaceAll('"','""')+'"';
  const definitions=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const output=['PRAGMA foreign_keys=OFF;','BEGIN TRANSACTION;'];
  function rows(name) {
    const table=identifier(name),columns=db.prepare(`PRAGMA table_info(${table})`).all();
    const fields=columns.flatMap((column,index)=>{
      const key=identifier(column.name);
      return [`typeof(${key}) AS t${index}`,`CASE typeof(${key}) WHEN 'integer' THEN CAST(${key} AS TEXT) WHEN 'real' THEN printf('%!.26g',${key}) ELSE hex(CAST(${key} AS BLOB)) END AS v${index}`];
    });
    // Encode text within SQLite: direct Node TEXT reads can truncate embedded
    // NUL bytes. Integer/REAL rendering also stays exact before JS transport.
    for(const row of db.prepare(`SELECT ${fields.join(',')} FROM ${table}`).iterate()) {
      const values=columns.map((_,index)=>{
        const type=row[`t${index}`],value=row[`v${index}`];
        if(type==='null')return 'NULL';
        if(type==='integer')return value;
        if(type==='real')return value==='Inf'?'CAST(1e999 AS REAL)':value==='-Inf'?'CAST(-1e999 AS REAL)':`CAST('${value}' AS REAL)`;
        if(type==='text')return `CAST(X'${value}' AS TEXT)`;
        if(type==='blob')return `X'${value}'`;
        invalid();
      });
      output.push(`INSERT INTO ${table} VALUES(${values.join(',')});`);
    }
  }
  for(const table of definitions.filter(item=>item.type==='table')) {
    output.push(table.sql+';');rows(table.name);
  }
  // Preserve deleted-ID high watermarks, so restored inserts cannot reuse them.
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
    output.push('DELETE FROM sqlite_sequence;');
    rows('sqlite_sequence');
  }
  for(const item of definitions.filter(item=>item.type!=='table'))output.push(item.sql+';');
  output.push('COMMIT;','PRAGMA foreign_keys=ON;');return output.join('\n');
}
