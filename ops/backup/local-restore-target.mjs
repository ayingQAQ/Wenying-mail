import {createRequire} from 'node:module';
import {mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {schemaQuery,schemaContract,rowQuery,rowsDigest} from './database-contract.mjs';
const require=createRequire(new URL('../../mail-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Local-only clean target. No credentials or remote endpoints are accepted.
// Existing paths are rejected, including incomplete earlier restore attempts.
export function localRestoreTarget(directory) {
  const root=resolve(directory);let runtime,db,r2,kv;const written=[];
  return {
    async begin() {
      await mkdir(root,{mode:0o700});
      try {
        const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,modules:true,script:'export default {fetch(){return new Response("Local restore target",{status:404})}}',
          compatibilityDate:'2026-09-01',d1Databases:{db:'restore'},r2Buckets:{r2:'restore'},kvNamespaces:{kv:'restore'},
          resourcePersistencePath:join(root,'storage')});
        options.telemetry={enabled:false};runtime=new Miniflare(options);
        [db,r2,kv]=await Promise.all([runtime.getD1Database('db'),runtime.getR2Bucket('r2'),runtime.getKVNamespace('kv')]);
      } catch(error){await runtime?.dispose();throw error;}
    },
    async putObject(object,data) {
      if(!runtime||!['r2','kv'].includes(object.backend))throw new Error('LOCAL_RESTORE_BACKEND_UNSUPPORTED');
      if(object.backend==='r2')await r2.put(object.key,data,{sha256:createHash('sha256').update(data).digest(),customMetadata:object.customMetadata,httpMetadata:{...object.httpMetadata,
        ...(object.httpMetadata.cacheExpiry?{cacheExpiry:new Date(object.httpMetadata.cacheExpiry)}:{})}});
      else await kv.put(object.key,data,{metadata:object.customMetadata});
      written.push({backend:object.backend,key:object.key,size:data.length,sha256:hash(data),metadata:object.customMetadata,httpMetadata:object.httpMetadata});
    },
    async importDatabase(sql,{signal}={}) {
      const statements=unstable_splitSqlQuery(sql).filter(statement=>!/^\s*(BEGIN|COMMIT|PRAGMA foreign_keys)\b/i.test(statement));
      for(let offset=0;offset<statements.length;offset+=20){signal?.throwIfAborted();await db.batch(statements.slice(offset,offset+20).map(statement=>db.prepare(statement)));}
    },
    async verify(contract,{signal}={}) {
      signal?.throwIfAborted();
      if(!contract?.tables?.length)throw new Error('RESTORE_CONTRACT_REQUIRED');
      const definitions=(await db.prepare(schemaQuery).all()).results.filter(row=>row.name!=='_cf_METADATA');
      if(!isDeepStrictEqual(schemaContract(definitions),contract.schema))throw new Error('RESTORE_SCHEMA_MISMATCH');
      for(const table of contract.tables) {
        signal?.throwIfAborted();
        const rows=(await db.prepare(rowQuery(table.name,table.columns)).all()).results;
        const actual=rowsDigest(rows,table.columns);
        if(actual.count!==table.count||actual.sha256!==table.sha256)throw new Error('RESTORE_DATA_MISMATCH');
      }
      for(const expected of written) {
        signal?.throwIfAborted();
        let data,metadata,httpMetadata;
        if(expected.backend==='r2') {const object=await r2.get(expected.key);if(!object)throw new Error('RESTORE_OBJECT_MISSING');
          if(!object.checksums?.sha256||Buffer.from(object.checksums.sha256).toString('hex')!==expected.sha256){await object.body?.cancel();throw new Error('RESTORE_OBJECT_CHECKSUM_MISSING');}
          data=Buffer.from(await object.arrayBuffer());metadata=object.customMetadata;httpMetadata=object.httpMetadata;}
        else {const result=await kv.getWithMetadata(expected.key,{type:'arrayBuffer'});if(!result.value)throw new Error('RESTORE_OBJECT_MISSING');data=Buffer.from(result.value);metadata=result.metadata;}
        if(data.length!==expected.size||hash(data)!==expected.sha256||!isDeepStrictEqual(metadata,expected.metadata)||
          expected.backend==='r2'&&!isDeepStrictEqual(JSON.parse(JSON.stringify(httpMetadata)),expected.httpMetadata))throw new Error('RESTORE_OBJECT_MISMATCH');
      }
      const result=await db.prepare(`SELECT (SELECT count(*) FROM sessions) sessions,
        (SELECT count(*) FROM account WHERE receive_enabled<>0) accounts,
        (SELECT count(*) FROM domains WHERE enabled<>0) domains,
        (SELECT count(*) FROM storage_maintenance WHERE kind<>'IDLE') holds`).first();
      if(Object.values(result).some(value=>value!==0))throw new Error('RESTORE_NOT_ISOLATED');
    },
    async finish(report) {
      const file=await open(join(root,'restore.pending'),'wx',0o600);
      try {await file.writeFile(JSON.stringify({...report,environment:'local-miniflare',objectCount:written.length}));await file.sync();}
      finally {await file.close();}
      await rename(join(root,'restore.pending'),join(root,'restore-report.json'));
    },
    async close(){await runtime?.dispose();runtime=null;},
  };
}
