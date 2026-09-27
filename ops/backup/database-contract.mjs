import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ddlSignature} from '../../mail-worker/src/database/legacy-adoption.js';

export const schemaQuery="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name";
export const identifier=name=>'"'+name.replaceAll('"','""')+'"';
const hash=value=>createHash('sha256').update(value).digest('hex');
const cached=new Map();
const adoptedCached=new Map();
// Remove formatting and comments, but retain quoted values/identifiers exactly.
// A different spelling of equivalent DDL is conservatively rejected.
function tokens(sql) {
  const expression=/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\.[0-9]+)?|[^\s]/gy;
  const output=[];let match,end=0;
  while((match=expression.exec(sql))!==null) {
    end=expression.lastIndex;const value=match[0];
    if(/^\s|^--|^\/\*/.test(value))continue;
    output.push(/^[A-Za-z_]/.test(value)?value.toLowerCase():value);
  }
  if(end!==sql.length)throw new Error('INVALID_SCHEMA_SQL');
  return output;
}
export function schemaContract(rows) {
  return rows.map(row=>({type:row.type,name:row.name,table:row.tbl_name,sql:tokens(row.sql)}));
}
export function trustedSchema(expected) {
  const key=JSON.stringify(expected);if(cached.has(key))return cached.get(key);
  const root=new URL('../../mail-worker/migrations/',import.meta.url);
  const names=readdirSync(root).filter(name=>name.endsWith('.sql')).sort();
  if(!expected.length||expected.length>names.length)throw new Error('UNTRUSTED_SCHEMA');
  const sources=expected.map((item,index)=>{
    if(item.version!==names[index])throw new Error('UNTRUSTED_SCHEMA');
    const sql=readFileSync(new URL(item.version,root),'utf8').replaceAll('\r\n','\n');
    if(hash(sql)!==item.checksum)throw new Error('UNTRUSTED_SCHEMA');return sql;
  });
  const db=new DatabaseSync(':memory:',{allowExtension:false});
  try {
    db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for(const source of sources)db.exec(source);
    const contract=schemaContract(db.prepare(schemaQuery).all());cached.set(key,contract);return contract;
  } finally {db.close();}
}
function trustedAdoptedSchema(expected) {
  const key=JSON.stringify(expected);if(adoptedCached.has(key))return adoptedCached.get(key);
  // Validate every migration identity through the fresh schema trust root first.
  trustedSchema(expected);
  const root=new URL('../../mail-worker/migrations/',import.meta.url);
  const sources=expected.map(item=>readFileSync(new URL(item.version,root),'utf8'));
  const baseline=new DatabaseSync(':memory:',{allowExtension:false});
  const legacy=new DatabaseSync(':memory:',{allowExtension:false});
  try {
    baseline.exec(sources[0]);
    const indexes=baseline.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL").all();
    legacy.exec(readFileSync(new URL('../../mail-worker/scripts/legacy-schema/ec7a2bb.sql',import.meta.url),'utf8'));
    const optionalIndexes=new Set(legacy.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all()
      .map(row=>row.name).filter(name=>!indexes.some(index=>index.name===name)));
    const oldTables=new Set(legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name));
    for(const index of indexes){
      legacy.exec(`DROP INDEX IF EXISTS ${identifier(index.name)}`);legacy.exec(index.sql);
    }
    legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for(const source of sources.slice(1))legacy.exec(source);
    const definitions=legacy.prepare(schemaQuery).all();
    const result={definitions,optionalIndexes,oldTables};adoptedCached.set(key,result);return result;
  } finally {baseline.close();legacy.close();}
}
export function assertTrustedSchema(db,expected) {
  const actual=db.prepare(schemaQuery).all();
  if(JSON.stringify(schemaContract(actual))===JSON.stringify(trustedSchema(expected)))return;
  // Only the independently reconstructed adopted profile is an alternative.
  // New tables/triggers/constraints and required indexes remain exact; historical
  // auxiliary indexes may be absent because adoption only installs baseline ones.
  const known=trustedAdoptedSchema(expected),byName=new Map(known.definitions.map(row=>[row.name,row]));
  for(const row of actual){
    const trusted=byName.get(row.name);
    if(!trusted||row.type!==trusted.type||row.tbl_name!==trusted.tbl_name)throw new Error('UNTRUSTED_SCHEMA');
    const same=row.type==='table'&&known.oldTables.has(row.name)
      ? ddlSignature(row.sql,true)===ddlSignature(trusted.sql,true)
      : JSON.stringify(tokens(row.sql))===JSON.stringify(tokens(trusted.sql));
    if(!same)throw new Error('UNTRUSTED_SCHEMA');
    byName.delete(row.name);
  }
  if([...byName.values()].some(row=>row.type!=='index'||!known.optionalIndexes.has(row.name)))throw new Error('UNTRUSTED_SCHEMA');
}
export function rowQuery(table,columns) {
  // SQLite renders values before transport, avoiding JS integer precision loss.
  // A default REAL-to-text cast rounds to 15 digits and can hide changed values.
  const values=columns.map((name,index)=>{
    const column=identifier(name);
    return `typeof(${column})||':'||CASE WHEN typeof(${column})='real' THEN printf('%!.26g',${column}) ELSE hex(CAST(${column} AS BLOB)) END AS c${index}`;
  });
  return `SELECT ${values.join(',')} FROM ${identifier(table)}`;
}
export function rowsDigest(rows,columns) {
  return fingerprintsDigest(rows.map(row=>rowFingerprint(row,columns)));
}
function canonicalCell(value) {
  if(typeof value!=='string')throw new Error('INVALID_DATABASE_CELL');
  if(!value.startsWith('real:'))return value;
  const decimal=value.slice(5);
  if(!/^-?(?:[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?|Inf)$/i.test(decimal))throw new Error('INVALID_DATABASE_REAL');
  const number=decimal==='Inf'?Infinity:decimal==='-Inf'?-Infinity:Number(decimal);
  if(Number.isNaN(number))throw new Error('INVALID_DATABASE_REAL');
  // SQLite releases differ in decimal trailing digits even for the same REAL.
  // Round-trip the high-precision text into the IEEE-754 value before hashing.
  const bytes=Buffer.allocUnsafe(8);bytes.writeDoubleBE(number===0?0:number);
  return 'real:'+bytes.toString('hex');
}
export const rowFingerprint=(row,columns)=>hash(JSON.stringify(columns.map((_,index)=>canonicalCell(row[`c${index}`]))));
export function fingerprintsDigest(fingerprints) {
  return {count:fingerprints.length,sha256:hash(fingerprints.sort().join('\n'))};
}
export function databaseContract(db) {
  const definitions=db.prepare(schemaQuery).all(),tables=[];
  for(const table of definitions.filter(row=>row.type==='table')) {
    const columns=db.prepare(`PRAGMA table_info(${identifier(table.name)})`).all().map(row=>row.name);
    tables.push({name:table.name,columns,...rowsDigest(db.prepare(rowQuery(table.name,columns)).all(),columns)});
  }
  return {schema:schemaContract(definitions),tables};
}
