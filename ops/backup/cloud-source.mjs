import {r2Source} from './r2-source.mjs';
import {exportD1} from './d1-export.mjs';

// Explicit configuration only. This factory neither exports SQL nor acquires
// a hold. runBackup controls that ordering. Legacy sources are opt-in adapters.
export function cloudSource({r2,d1,legacy={}}) {
  if(!d1||r2?.accountId!==d1.accountId||Object.keys(legacy).some(key=>!['kv','s3'].includes(key))||
    Object.values(legacy).some(source=>typeof source?.readObject!=='function'))throw new Error('INVALID_CLOUD_SOURCE');
  const storage=r2Source(r2);
  return {
    exportDatabase:signal=>exportD1({...d1,signal}),
    inventory:(snapshotAt,signal)=>storage.inventory(snapshotAt,signal),
    readObject(backend,key,signal) {
      if(backend==='r2')return storage.readObject(backend,key,signal);
      if(!legacy[backend])throw new Error('LEGACY_SOURCE_UNCONFIGURED');
      return legacy[backend].readObject(backend,key,signal);
    },
    close(){storage.close();for(const source of Object.values(legacy))source.close?.();},
  };
}
