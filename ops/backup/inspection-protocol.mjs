export const limits={header:1024*1024,ledger:32*1024*1024,sql:512*1024*1024};
const invalid=()=>{throw new Error('INVALID_INSPECTION_INPUT');};
function headerOptions(header) {
  const keys=['protocol','schema','legacyBackend','maxObjects','action','ledgerThrough','ledgerBytes','sqlBytes'];
  if(!header||header.protocol!==2||Object.keys(header).some(key=>!keys.includes(key))||
    !['inspect','restore','contract','d1-contract'].includes(header.action)||!Array.isArray(header.schema)||
    !Number.isSafeInteger(header.ledgerBytes)||header.ledgerBytes<2||header.ledgerBytes>limits.ledger||
    !Number.isSafeInteger(header.sqlBytes)||header.sqlBytes<0||header.sqlBytes>limits.sql)invalid();
}
export function encodeInspection({sql,latestLedger=[],...options}) {
  if(!Buffer.isBuffer(sql)||sql.length>limits.sql||!Array.isArray(latestLedger))invalid();
  const ledger=Buffer.from(JSON.stringify(latestLedger));
  const header={...options,protocol:2,ledgerBytes:ledger.length,sqlBytes:sql.length};headerOptions(header);
  const bytes=Buffer.from(JSON.stringify(header)+'\n');if(bytes.length-1>limits.header)invalid();
  return [bytes,ledger,sql];
}

// Separate bounded sections keep deletion records out of the configuration
// header. Reject truncated, trailing or over-limit input before SQLite opens.
export async function decodeInspection(stream) {
  let header,headerSize=0,ledgerSize=0,sqlSize=0;const head=[],ledger=[],sql=[];
  for await(const raw of stream) {
    let chunk=Buffer.from(raw);
    if(!header) {
      const newline=chunk.indexOf(10),part=newline<0?chunk:chunk.subarray(0,newline);
      headerSize+=part.length;if(headerSize>limits.header)invalid();head.push(part);
      if(newline<0)continue;
      header=JSON.parse(Buffer.concat(head).toString('utf8'));headerOptions(header);head.length=0;chunk=chunk.subarray(newline+1);
    }
    const count=Math.min(chunk.length,header.ledgerBytes-ledgerSize);
    if(count){ledger.push(chunk.subarray(0,count));ledgerSize+=count;chunk=chunk.subarray(count);}
    if(chunk.length){sqlSize+=chunk.length;if(sqlSize>header.sqlBytes)invalid();sql.push(chunk);}
  }
  if(!header||ledgerSize!==header.ledgerBytes||sqlSize!==header.sqlBytes)invalid();
  const latestLedger=JSON.parse(Buffer.concat(ledger).toString('utf8'));if(!Array.isArray(latestLedger))invalid();
  return {options:header,latestLedger,sql:Buffer.concat(sql)};
}
