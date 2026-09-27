import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {d1Api} from './d1-api.mjs';
import {importD1} from './d1-import.mjs';
import {inspectSql} from './inspect-process.mjs';
import {schemaQuery,schemaContract,rowQuery,rowFingerprint,fingerprintsDigest} from './database-contract.mjs';

const marker='_mail_restore_reservation';
const prefix='PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n',suffix='\nCOMMIT;\nPRAGMA foreign_keys=ON;';
function assertRowidTables(contract) {
  // Current trusted migrations use ordinary rowid tables. A future migration
  // must supply a reviewed pagination key before WITHOUT ROWID/shadowed rowid
  // tables can be restored; never silently fall back to repeated full scans.
  for(const table of contract.tables) {
    const definition=contract.schema.find(row=>row.type==='table'&&row.name===table.name);
    if(!definition||table.columns.some(name=>name.toLowerCase()==='rowid')||
      definition.sql.some((token,index)=>token==='without'&&definition.sql[index+1]==='rowid'))throw Error('D1_RESTORE_ROWID_UNSUPPORTED');
  }
}
export function d1RestoreDatabase({accountId,databaseId,sourceDatabaseId,databaseName,token,uploadOrigins,schema,legacyBackend,signal,fetcher=fetch,
  pageSize=100,maxRows=1000000,maxResponseBytes=8*1024*1024,importOptions={}}) {
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sourceDatabaseId)||sourceDatabaseId===databaseId||
    typeof databaseName!=='string'||!databaseName||databaseName.length>128||!signal||!Array.isArray(schema)||!schema.length||
    !Array.isArray(uploadOrigins)||!uploadOrigins.length||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000||
    !Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1000000)throw Error('INVALID_D1_RESTORE_CONFIG');
  // Validate every upload origin before reserving or querying any target.
  for(const origin of uploadOrigins){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw Error('INVALID_D1_RESTORE_CONFIG');}
  const stop=new AbortController(),runSignal=AbortSignal.any([signal,stop.signal]);
  const api=d1Api({accountId,databaseId,token,fetcher,maxResponseBytes});
  const owner=randomUUID();let state='NEW',expectedContract,verifiedBookmark,verificationPasses=0;
  const guard=`SELECT CASE WHEN (SELECT count(*) FROM "${marker}")=1 AND EXISTS(SELECT 1 FROM "${marker}" WHERE owner='${owner}') THEN 1 ELSE json('RESTORE_OWNERSHIP_LOST') END;`;
  const step=(expected,next)=>{runSignal.throwIfAborted();if(state!==expected)throw Error('D1_RESTORE_STATE_INVALID');state=next;};
  async function query(sql,params=[]) {
    const result=await api('/query',{body:{sql,params},signal:runSignal});
    if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results))throw Error('D1_RESTORE_QUERY_FAILED');
    return result[0].results;
  }
  async function own(){await query(guard);}
  async function bookmark(){const result=await api('/time_travel/bookmark',{signal:runSignal});if(typeof result.bookmark!=='string'||!result.bookmark||result.bookmark.length>1024)throw Error('D1_RESTORE_BOOKMARK_INVALID');return result.bookmark;}
  const importSql=sql=>importD1({...importOptions,accountId,databaseId,token,uploadOrigins,fetcher,sql:Buffer.from(sql),signal:runSignal});
  async function verifyData(reserved) {
    const before=await bookmark();if(reserved)await own();
    const definitions=(await query(schemaQuery)).filter(row=>row.name!=='_cf_KV'&&(!reserved||row.name!==marker));
    if(!isDeepStrictEqual(schemaContract(definitions),expectedContract.schema))throw Error('D1_RESTORE_SCHEMA_MISMATCH');
    for(const table of expectedContract.tables) {
      let cursor=null,limit=pageSize;const fingerprints=[];
      const select=rowQuery(table.name,table.columns).replace(/^SELECT /,'SELECT CAST(rowid AS TEXT) AS _restore_rowid,');
      while(true) {
        runSignal.throwIfAborted();let rows;
        try{rows=await query(select+(cursor===null?'':' WHERE rowid>CAST(? AS INTEGER)')+' ORDER BY rowid LIMIT ?',cursor===null?[limit]:[cursor,limit]);}
        catch(error){if(error.message==='D1_RESPONSE_LIMIT'&&limit>1){limit=Math.max(1,Math.floor(limit/2));continue;}throw error;}
        if(rows.length>limit||fingerprints.length+rows.length>maxRows)throw Error('D1_RESTORE_ROW_LIMIT');
        for(const row of rows){
          const next=row._restore_rowid;
          if(typeof next!=='string'||next.length>20||!/^(?:0|-?[1-9][0-9]*)$/.test(next)||
            BigInt(next)<-9223372036854775808n||BigInt(next)>9223372036854775807n||
            cursor!==null&&BigInt(next)<=BigInt(cursor)||table.columns.some((_,i)=>typeof row[`c${i}`]!=='string'))throw Error('D1_RESTORE_ROW_INVALID');
          fingerprints.push(rowFingerprint(row,table.columns));cursor=next;
        }
        if(rows.length<limit)break;
      }
      const actual=fingerprintsDigest(fingerprints);
      if(actual.count!==table.count||actual.sha256!==table.sha256)throw Error('D1_RESTORE_DATA_MISMATCH');
    }
    if(reserved)await own();const after=await bookmark();
    if(before!==after)throw Error('D1_RESTORE_CONCURRENT_WRITE');return after;
  }
  async function verifyStableData(reserved) {
    // Import completion does not guarantee a quiet bookmark interval. Never
    // accept a moving scan: repeat the entire comparison once, then fail closed.
    for(let attempt=0;attempt<2;attempt++){
      try{verificationPasses++;return await verifyData(reserved);}
      catch(error){if(attempt!==0||error.message!=='D1_RESTORE_CONCURRENT_WRITE')throw error;}
    }
  }
  const failure=error=>{state='FAILED';throw Error(runSignal.aborted?'D1_RESTORE_ABORTED':/^D1_RESTORE_/.test(error.message)?error.message:'D1_RESTORE_FAILED');};
  return {
    async begin() {
      step('NEW','RESERVING');
      try {
        const database=await api('',{signal:runSignal});
        if(database.uuid!==databaseId||database.name!==databaseName)throw Error('D1_RESTORE_TARGET_MISMATCH');
        if((await query(schemaQuery)).some(row=>row.name!=='_cf_KV'))throw Error('D1_RESTORE_NOT_EMPTY');
        // One CREATE statement atomically reserves a previously empty schema.
        // No IF NOT EXISTS: another restore's reservation must cause failure.
        await query(`CREATE TABLE "${marker}" AS SELECT '${owner}' AS owner WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT IN ('_cf_KV','${marker}'))`);
        await own();state='RESERVED';
      }catch(error){failure(error);}
    },
    async importDatabase(sql) {
      step('RESERVED','IMPORTING');
      try {
        if(typeof sql!=='string'||!sql.startsWith(prefix)||!sql.endsWith(suffix))throw Error('D1_RESTORE_PREPARED_SQL_REQUIRED');
        const inspected=await inspectSql({sql:Buffer.from(sql),schema,legacyBackend,signal:runSignal,action:'d1-contract'});
        if(Object.values(inspected.isolation).some(n=>n!==0)||inspected.contract.tables.some(t=>t.count>maxRows))throw Error('D1_RESTORE_NOT_ISOLATED');
        expectedContract=inspected.contract;
        assertRowidTables(expectedContract);
        await own();
        const remaining=(await query(schemaQuery)).filter(row=>!['_cf_KV',marker].includes(row.name));
        if(remaining.length)throw Error('D1_RESTORE_NOT_EMPTY');
        if(typeof inspected.d1Sql!=='string'||!inspected.d1Sql)throw Error('D1_RESTORE_PREPARED_SQL_REQUIRED');
        // The isolated exporter bounds every D1 statement, including long bodies.
        // D1 import owns the transaction; the ownership guard precedes its payload.
        await importSql('PRAGMA defer_foreign_keys=ON;\n'+guard+'\n'+inspected.d1Sql);
        await own();state='IMPORTED';
      }catch(error){failure(error);}
    },
    async verify(contract) {
      step('IMPORTED','VERIFYING');
      try {
        if(!isDeepStrictEqual(contract,expectedContract))throw Error('D1_RESTORE_CONTRACT_MISMATCH');
        verifiedBookmark=await verifyStableData(true);state='VERIFIED';
      }catch(error){failure(error);}
    },
    async finish() {
      step('VERIFIED','FINISHING');
      try {
        if(await bookmark()!==verifiedBookmark)throw Error('D1_RESTORE_CONCURRENT_WRITE');
        await own();
        // Remove only the reservation created by this instance, never user tables.
        await importSql(guard+`\nDROP TABLE "${marker}";`);
        const finalBookmark=await verifyStableData(false);
        state='COMPLETE';
        return {databaseId,finalBookmark,verificationPasses,databaseVerified:true,receivingEnabled:false,requiresAcceptance:true};
      }catch(error){failure(error);}
    },
    async close(){stop.abort();if(state!=='COMPLETE')state='CLOSED';},
  };
}
