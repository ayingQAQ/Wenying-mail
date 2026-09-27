const fail=()=>new Error('D1_REMOTE_UNAVAILABLE');
function parameter(value){
  if(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return value;
  if(value instanceof ArrayBuffer)return Array.from(new Uint8Array(value));
  if(ArrayBuffer.isView(value))return Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
  throw new Error('D1_INVALID_BINDING');
}
function validateValue(value){
  if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw fail();
  if(value!==null&&typeof value==='object'&&!Array.isArray(value))throw fail();
}
// Preserve server column ordering via /raw. Object key ordering is insufficient
// for Drizzle positional decoding, especially numeric aliases/duplicate names.
export function remoteD1({databaseId,request}){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId)||typeof request!=='function')throw new Error('INVALID_D1_CONFIG');
  const owned=new WeakSet();
  async function execute(statements){
    if(!statements.length||statements.length>100||statements.some(s=>!owned.has(s)))throw fail();
    const query=statements.map(s=>({sql:s.sql,params:s.params}));
    const result=await request(`/d1/database/${databaseId}/raw`,{body:query.length===1?query[0]:{batch:query}});
    if(!Array.isArray(result)||result.length!==statements.length)throw fail();
    return result.map(value=>{
      const columns=value.results?.columns??[],rows=value.results?.rows??[];
      if(value.success!==true||value.meta?.served_by_primary===false||!Array.isArray(columns)||columns.some(c=>typeof c!=='string')||!Array.isArray(rows))throw fail();
      for(const row of rows){if(!Array.isArray(row)||row.length!==columns.length)throw fail();for(const cell of row)validateValue(cell);}
      return {columns,rows,success:true,meta:value.meta??{}};
    });
  }
  const mapped=value=>({success:true,meta:value.meta,results:value.rows.map(row=>Object.fromEntries(value.columns.map((name,index)=>[name,row[index]])))});
  function prepare(sql,params=[]){
    if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>100000)throw new Error('D1_INVALID_SQL');
    const statement={sql,params,
      bind(...values){return prepare(sql,values.map(parameter));},
      async all(){return mapped((await execute([statement]))[0]);},
      async run(){return statement.all();},
      async first(column){const row=(await statement.all()).results[0];if(!row)return null;if(column===undefined)return row;if(!Object.hasOwn(row,column))throw fail();return row[column];},
      async raw({columnNames=false}={}){const value=(await execute([statement]))[0];return columnNames?[value.columns,...value.rows]:value.rows;},
    };
    Object.freeze(params);Object.freeze(statement);owned.add(statement);return statement;
  }
  return {prepare,batch:async statements=>(await execute(statements)).map(mapped)};
}
