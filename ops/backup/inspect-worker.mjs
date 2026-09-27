import {openDatabaseSnapshot,databaseReferences,prepareRestoredDatabase,exportPreparedDatabase} from './database-snapshot.mjs';
import {databaseContract} from './database-contract.mjs';
import {decodeInspection} from './inspection-protocol.mjs';
import {exportD1Database} from './d1-sql-export.mjs';
try {
  const {options,latestLedger,sql}=await decodeInspection(process.stdin);
  const db=openDatabaseSnapshot(sql.toString('utf8'),options.schema);
  try {
    let preparedSql,report,contract,isolation,d1Sql;
    if(options.action==='restore') {
      report=prepareRestoredDatabase(db,latestLedger,{ledgerThrough:options.ledgerThrough});
      preparedSql=exportPreparedDatabase(db);
      contract=databaseContract(db);
    }
    if(options.action==='contract'||options.action==='d1-contract') {
      contract=databaseContract(db);
      isolation=db.prepare(`SELECT (SELECT count(*) FROM sessions) sessions,
        (SELECT count(*) FROM account WHERE receive_enabled<>0) accounts,
        (SELECT count(*) FROM domains WHERE enabled<>0) domains,
        (SELECT count(*) FROM storage_maintenance WHERE kind<>'IDLE') holds`).get();
    }
    if(options.action==='d1-contract')d1Sql=exportD1Database(db,options.schema);
    const references=databaseReferences(db,{legacyBackend:options.legacyBackend,maxObjects:options.maxObjects});
    const ledger=db.prepare('SELECT delivery_id AS deliveryId,deleted_at AS deletedAt,reason_code AS reasonCode FROM mail_tombstones ORDER BY delivery_id').all();
    process.stdout.write(JSON.stringify({references,ledger,...(preparedSql?{preparedSql,report,contract}:{}),...(isolation?{contract,isolation}:{}),...(d1Sql?{d1Sql}:{})}));
  } finally {db.close();}
} catch {process.exitCode=1;}
