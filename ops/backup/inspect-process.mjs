import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {encodeInspection} from './inspection-protocol.mjs';

export async function inspectSql({sql,schema,legacyBackend,maxObjects=100000,timeoutMs=30000,signal,action='inspect',latestLedger,ledgerThrough}) {
  if(!Buffer.isBuffer(sql)||sql.length>512*1024*1024||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||
    !Number.isSafeInteger(maxObjects)||maxObjects<1||maxObjects>1000000||!['inspect','restore','contract','d1-contract'].includes(action)||signal?.aborted)throw new Error('INVALID_SQL_INSPECTION');
  const input=encodeInspection({sql,schema,legacyBackend,maxObjects,action,latestLedger,ledgerThrough});
  const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./inspect-worker.mjs',import.meta.url))],{
    shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,NODE_OPTIONS:''}});
  const abort=()=>child.kill(),timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  const exited=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('SQL_INSPECTION_FAILED')));child.once('close',code=>code===0?resolve():reject(new Error('SQL_INSPECTION_FAILED')));});
  let size=0;const output=[];
  const read=(async()=>{for await(const chunk of child.stdout){size+=chunk.length;if(size>64*1024*1024){child.kill();throw new Error('SQL_INSPECTION_LIMIT');}output.push(chunk);}})();
  const feed=pipeline(Readable.from(input),child.stdin);
  try {
    const results=await Promise.allSettled([exited,read,feed].map(task=>task.catch(error=>{child.kill();throw error;})));
    if(results.some(result=>result.status==='rejected')||signal?.aborted)throw new Error('SQL_INSPECTION_FAILED');
    return JSON.parse(Buffer.concat(output).toString('utf8'));
  } catch {throw new Error('SQL_INSPECTION_FAILED');}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
