import {DatabaseSync} from 'node:sqlite';import {lstatSync,chmodSync} from 'node:fs';import {isAbsolute} from 'node:path';
export function localKV(path){
 if(!isAbsolute(path))throw Error('INVALID_LOCAL_KV_PATH');
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('INVALID_LOCAL_KV_FILE');chmodSync(path,0o600);
 const db=new DatabaseSync(path);try{db.prepare('SELECT key,value,metadata FROM kv LIMIT 0').all();db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');}catch(error){db.close();throw error;}
 const valid=key=>{if(typeof key!=='string'||!key||Buffer.byteLength(key)>512||key==='.'||key==='..')throw Error('INVALID_KV_KEY');return key;};
 function value(row,options={}){if(!row)return null;const type=typeof options==='string'?options:options.type??'text';
  if(type==='arrayBuffer')return Uint8Array.from(row.value).buffer;
  const text=Buffer.from(row.value).toString('utf8');if(type==='json')return JSON.parse(text);if(type==='text')return text;throw Error('INVALID_KV_TYPE');}
 return {
  async get(key,options){return value(db.prepare('SELECT value FROM kv WHERE key=?').get(valid(key)),options);},
  async getWithMetadata(key,options){const row=db.prepare('SELECT value,metadata FROM kv WHERE key=?').get(valid(key));return {value:value(row,options),metadata:row?.metadata?JSON.parse(row.metadata):null};},
  async put(key,input,options={}){valid(key);if(Object.keys(options).some(k=>k!=='metadata'))throw Error('INVALID_KV_OPTIONS');
   const bytes=typeof input==='string'?Buffer.from(input):input instanceof ArrayBuffer?Buffer.from(input):ArrayBuffer.isView(input)?Buffer.from(input.buffer,input.byteOffset,input.byteLength):null;
   if(!bytes||bytes.length>25*1024*1024)throw Error('INVALID_KV_VALUE');
   const metadata=options.metadata===undefined?null:JSON.stringify(options.metadata);if(metadata!==null&&typeof metadata!=='string')throw Error('INVALID_KV_METADATA');
   db.prepare('INSERT INTO kv(key,value,metadata) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,metadata=excluded.metadata').run(key,bytes,metadata);},
  async delete(key){db.prepare('DELETE FROM kv WHERE key=?').run(valid(key));},
  async list({prefix='',cursor,limit=1000}={}){if(typeof prefix!=='string'||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('INVALID_KV_LIST');
   let after='';if(cursor){try{const v=JSON.parse(Buffer.from(cursor,'base64url'));if(v.prefix!==prefix||typeof v.after!=='string')throw Error();after=v.after;}catch{throw Error('INVALID_KV_CURSOR');}}
   const rows=db.prepare('SELECT key,metadata FROM kv WHERE substr(key,1,length(?))=? AND key>? ORDER BY key LIMIT ?').all(prefix,prefix,after,limit+1),more=rows.length>limit,keys=rows.slice(0,limit).map(r=>({name:r.key,...(r.metadata?{metadata:JSON.parse(r.metadata)}:{})}));
   return {keys,list_complete:!more,cursor:more?Buffer.from(JSON.stringify({prefix,after:keys.at(-1).name})).toString('base64url'):''};},
  close(){db.close();},
 };
}
