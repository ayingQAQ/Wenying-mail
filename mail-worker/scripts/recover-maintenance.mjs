import {openLocalDatabase} from './local-database.js';
import {releaseAbandonedPurge} from '../src/processing/maintenance-recovery.js';
const args=process.argv.slice(2);let proxy;
try {
  if(args.length!==4||args[0]!=='--local'||args[1]!=='--workers-stopped'||args[2]!=='--owner')throw new Error('INVALID_ARGUMENTS');
  proxy=await openLocalDatabase();
  await releaseAbandonedPurge(proxy.env.db,{owner:args[3],quiescenceConfirmed:true});
  console.log(JSON.stringify({target:'local-only',released:true}));
}catch {console.error('MAINTENANCE_RECOVERY_FAILED: require stopped workers and matching expired PURGE owner');process.exitCode=1;}
finally {await proxy?.dispose();}
