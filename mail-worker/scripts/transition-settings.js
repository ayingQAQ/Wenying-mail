import {open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {openLocalDatabase} from './local-database.js';
import {inspectSettingsTransition,prepareSettingsTransition,applySettingsTransition} from '../../ops/backup/settings-transition.mjs';

// Secrets arrive through the environment and age identity file, never CLI values.
// The sole database target is the existing local admin copy; no remote mode exists.
const args=process.argv.slice(2);let proxy;
try {
  const inspect=args.length===4&&args[0]==='--local'&&args[1]==='--inspect'&&args[2]==='--legacy-backend';
  const prepare=args.length===6&&args[0]==='--local'&&args[1]==='--prepare'&&args[2]==='--legacy-backend'&&args[4]==='--receipt';
  const apply=args.length===5&&args[0]==='--local'&&args[1]==='--apply'&&args[2]==='--writers-stopped'&&args[3]==='--receipt';
  if(!inspect&&!prepare&&!apply)throw new Error('INVALID_ARGUMENTS');
  proxy=await openLocalDatabase();
  if(inspect)console.log(JSON.stringify({target:'local-only',...await inspectSettingsTransition(proxy.env.db,{backend:args[3]})}));
  else if(prepare){
    const path=resolve(args[5]);
    // Reserve the receipt first: a pre-existing path must never be replaced.
    const file=await open(path,'wx',0o600);
    try{
      const receipt=await prepareSettingsTransition({db:proxy.env.db,kv:proxy.env.kv,backend:args[3],directory:dirname(path),
        executable:process.env.AGE_BINARY,recipient:process.env.AGE_RECIPIENT});
      await file.writeFile(JSON.stringify(receipt));await file.sync();
    }finally{await file.close();}
    console.log(JSON.stringify({target:'local-only',prepared:true}));
  }else{
    const path=resolve(args[4]),file=await open(path,'r');let receipt;
    try{if((await file.stat()).size>8192)throw new Error('RECEIPT_TOO_LARGE');receipt=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
    const result=await applySettingsTransition({db:proxy.env.db,kv:proxy.env.kv,writersStopped:true,runtimeEnvironment:process.env,
      receipt,directory:dirname(path),executable:process.env.AGE_BINARY,identityFile:process.env.AGE_IDENTITY_FILE});
    console.log(JSON.stringify({target:'local-only',...result}));
  }
} catch {
  // SQL, crypto and file errors can include settings or paths. Do not print them.
  console.error('LOCAL_SETTINGS_TRANSITION_FAILED');process.exitCode=1;
} finally {await proxy?.dispose();}
