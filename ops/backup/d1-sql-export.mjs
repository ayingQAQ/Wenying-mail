import {randomUUID} from 'node:crypto';
import {assertTrustedSchema,identifier} from './database-contract.mjs';

export const d1SqlLimits=Object.freeze({statement:100000,row:2000000,output:64*1024*1024});
const fail=code=>{throw new Error(code);};
const textLiteral=hex=>`CAST(X'${hex}' AS TEXT)`;
const blobLiteral=hex=>`X'${hex}'`;
const varintBytes=value=>{let count=1;while(value>=128){value=Math.floor(value/128);count++;}return count;};
function integerSize(value) {
  const n=BigInt(value);if(n===0n||n===1n)return 0;
  for(const size of [1,2,3,4,6,8])if(n>=-(1n<<BigInt(size*8-1))&&n<(1n<<BigInt(size*8-1)))return size;
  fail('INVALID_D1_INTEGER');
}
function cell(type,value) {
  if(type==='null')return {type,value,bytes:0,serial:0,literal:'NULL'};
  if(type==='integer') {
    const bytes=integerSize(value),serial=bytes===0?(value==='0'?8:9):({1:1,2:2,3:3,4:4,6:5,8:6})[bytes];
    return {type,value,bytes,serial,literal:value};
  }
  if(type==='real')return {type,value,bytes:8,serial:7,
    literal:value==='Inf'?'CAST(9e999 AS REAL)':value==='-Inf'?'CAST(-9e999 AS REAL)':`CAST('${value}' AS REAL)`};
  if(type==='text'||type==='blob') {
    const bytes=value.length/2;if(bytes>d1SqlLimits.row)fail('D1_ROW_SIZE_LIMIT');
    return {type,value,bytes,serial:bytes*2+(type==='text'?13:12),literal:(type==='text'?textLiteral:blobLiteral)(value)};
  }
  fail('INVALID_D1_VALUE_TYPE');
}
function checkRowSize(cells,integerPrimaryKey) {
  // SQLITE_LIMIT_LENGTH applies to the encoded record, including its serial
  // header. An INTEGER PRIMARY KEY is the b-tree key and occupies a NULL slot.
  let data=0,serials=0;
  cells.forEach((item,index)=>{if(index===integerPrimaryKey){serials++;return;}data+=item.bytes;serials+=varintBytes(item.serial);});
  let header=serials+1;while(header!==serials+varintBytes(header))header=serials+varintBytes(header);
  if(data+header>d1SqlLimits.row)fail('D1_ROW_SIZE_LIMIT');
}

// Only the independently trusted migration schema is supported. The normal
// SQLite exporter remains unchanged; this variant targets D1's SQL byte limit.
// It emits payload statements without transaction/foreign-key wrappers, so the
// D1 importer can add its ownership guard and defer foreign keys atomically.
export function exportD1Database(db,schema) {
  assertTrustedSchema(db,schema);
  const definitions=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const output=[];let outputBytes=0;
  function emit(sql) {
    const bytes=Buffer.byteLength(sql);if(bytes>d1SqlLimits.statement)fail('D1_STATEMENT_SIZE_LIMIT');
    outputBytes+=bytes+1;if(outputBytes>d1SqlLimits.output)fail('D1_SQL_OUTPUT_LIMIT');output.push(sql);
  }
  function exportRows(name) {
    const table=identifier(name),columns=db.prepare(`PRAGMA table_info(${table})`).all();
    if(columns.some(column=>['_rowid_','rowid','oid'].includes(column.name.toLowerCase())))fail('UNSUPPORTED_D1_ROWID_SCHEMA');
    const primary=columns.filter(column=>column.pk>0);
    const integerPrimaryKey=primary.length===1&&primary[0].type.toUpperCase()==='INTEGER'?columns.indexOf(primary[0]):-1;
    const names=columns.map(column=>identifier(column.name));
    const query=columns.flatMap((column,index)=>{
      const name=identifier(column.name);return [`typeof(${name}) AS t${index}`,
        `CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT) WHEN 'real' THEN printf('%!.26g',${name}) ELSE hex(CAST(${name} AS BLOB)) END AS v${index}`];
    });
    const prefixes=new Map();
    function prefix(index,rowid) {
      // All temporary values start with a prefix absent from this source
      // column. Distinct rowids keep them mutually distinct, including for
      // inline UNIQUE/PRIMARY KEY constraints, until their final update.
      if(!prefixes.has(index)) {
        let base;
        for(let attempt=0;attempt<16;attempt++) {
          const candidate=`__mail_restore_${randomUUID()}__`,hex=Buffer.from(candidate).toString('hex');
          if(!db.prepare(`SELECT 1 FROM ${table} WHERE substr(CAST(${names[index]} AS BLOB),1,${Buffer.byteLength(candidate)})=X'${hex}' LIMIT 1`).get()){base=candidate;break;}
        }
        if(!base)fail('D1_VALUE_PREFIX_UNAVAILABLE');prefixes.set(index,base);
      }
      return Buffer.from(prefixes.get(index)+rowid+'__').toString('hex');
    }
    for(const row of db.prepare(`SELECT CAST(_rowid_ AS TEXT) AS r,${query.join(',')} FROM ${table} ORDER BY _rowid_`).iterate()) {
      const cells=columns.map((_,index)=>cell(row[`t${index}`],row[`v${index}`]));checkRowSize(cells,integerPrimaryKey);
      const values=cells.map(item=>item.literal),chunks=new Map();
      const insert=()=>`INSERT INTO ${table} (${integerPrimaryKey<0?'_rowid_,':''}${names.join(',')}) VALUES(${integerPrimaryKey<0?row.r+',':''}${values.join(',')});`;
      while(Buffer.byteLength(insert())>d1SqlLimits.statement) {
        let selected=-1;
        for(let index=0;index<cells.length;index++)if(!chunks.has(index)&&['text','blob'].includes(cells[index].type)&&cells[index].bytes>=1024&&
          (selected<0||cells[index].bytes>cells[selected].bytes))selected=index;
        if(selected<0)fail('D1_STATEMENT_SIZE_LIMIT');
        const initial=prefix(selected,row.r);chunks.set(selected,initial);
        values[selected]=(cells[selected].type==='text'?textLiteral:blobLiteral)(initial);
      }
      emit(insert());
      for(const [index,initial] of chunks) {
        const item=cells[index],column=names[index],cast=item.type==='text'?'TEXT':'BLOB';
        const sql=(hex,last)=>`UPDATE ${table} SET ${column}=CAST(${last?`substr(CAST(${column} AS BLOB),${initial.length/2+1})`:`CAST(${column} AS BLOB)`}||X'${hex}' AS ${cast}) WHERE _rowid_=${row.r};`;
        const capacity=Math.floor((d1SqlLimits.statement-Math.max(Buffer.byteLength(sql('',false)),Buffer.byteLength(sql('',true))))/2);
        if(capacity<1024)fail('D1_STATEMENT_SIZE_LIMIT');
        // Balance chunks so the final chunk is larger than the temporary
        // prefix. Intermediate values therefore never exceed final row size.
        const count=Math.ceil(item.bytes/capacity),size=Math.ceil(item.bytes/count);
        for(let start=0;start<item.value.length;start+=size*2) {
          const end=Math.min(item.value.length,start+size*2);emit(sql(item.value.slice(start,end),end===item.value.length));
        }
      }
    }
  }
  for(const table of definitions.filter(item=>item.type==='table')){emit(table.sql+';');exportRows(table.name);}
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {emit('DELETE FROM sqlite_sequence;');exportRows('sqlite_sequence');}
  // Triggers must not execute against partially reconstructed rows. Indexes
  // and triggers retain their original DDL and are installed after all data.
  for(const item of definitions.filter(item=>item.type!=='table'))emit(item.sql+';');
  return output.join('\n');
}
