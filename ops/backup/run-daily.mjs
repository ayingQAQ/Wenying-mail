import {lstat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCli} from './cli.mjs';

// UTC calendar date is only a stable job-directory name. runBackupJob owns the
// exclusive run lock, immutable configuration identity and resumable snapshot.
// This runner never prunes snapshots or turns a pending receipt into success.
export async function runDaily(argv,{now=new Date(),invoke=runCli,stderr=process.stderr,...options}={}) {
  let values;
  try {
    if(argv.length!==6)throw Error();values={};
    for(let i=0;i<argv.length;i+=2){
      const key=argv[i],value=argv[i+1];
      if(!['--config','--offsite-config','--job-root'].includes(key)||Object.hasOwn(values,key)||!value||!isAbsolute(value))throw Error();
      values[key]=resolve(value);
    }
    if(Object.keys(values).length!==3||!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error();
    const root=await lstat(values['--job-root']);if(!root.isDirectory()||root.isSymbolicLink())throw Error();
  }catch{stderr.write('{"error":"INVALID_DAILY_BACKUP_CONFIG"}\n');return 2;}
  return invoke(['backup-offsite','--config',values['--config'],'--offsite-config',values['--offsite-config'],
    '--run-directory',join(values['--job-root'],now.toISOString().slice(0,10))],{...options,stderr});
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const stop=new AbortController();
  const abort=()=>stop.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
  try{process.exitCode=await runDaily(process.argv.slice(2),{signal:stop.signal});}
  catch{console.error('{"error":"DAILY_BACKUP_FAILED"}');process.exitCode=1;}
  finally{process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);}
}
