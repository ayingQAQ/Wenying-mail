// Legacy provenance is explicit: never infer it from the new R2 binding.
export function legacyStorageConfig(source){
  const result={},backend=source.LEGACY_MAIL_STORAGE;
  if(source.LEGACY_BACKFILL_READ_MODE!==undefined){
    if(!['copy','source'].includes(source.LEGACY_BACKFILL_READ_MODE))throw new Error('INVALID_LEGACY_BACKFILL_READ_MODE');
    result.LEGACY_BACKFILL_READ_MODE=source.LEGACY_BACKFILL_READ_MODE;
  }
  if(backend){if(!['kv','r2','s3'].includes(backend))throw new Error('INVALID_LEGACY_STORAGE');result.LEGACY_MAIL_STORAGE=backend;}
  const keys=['LEGACY_S3_ENDPOINT','LEGACY_S3_BUCKET','LEGACY_S3_ACCESS_KEY_ID','LEGACY_S3_SECRET_ACCESS_KEY'];
  if(backend==='s3'||[...keys,'LEGACY_S3_REGION','LEGACY_S3_FORCE_PATH_STYLE'].some(key=>source[key])){
    for(const key of keys){const value=source[key];if(typeof value!=='string'||!value||value.trim()!==value||/[\x00-\x1f\x7f]/.test(value))throw new Error('INVALID_LEGACY_S3_CONFIG');result[key]=value;}
    let url;try{url=new URL(result.LEGACY_S3_ENDPOINT);}catch{throw new Error('INVALID_LEGACY_S3_CONFIG');}
    if(url.protocol!=='https:'||url.origin!==result.LEGACY_S3_ENDPOINT||url.username||url.password||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(result.LEGACY_S3_BUCKET)||result.LEGACY_S3_BUCKET.includes('..'))throw new Error('INVALID_LEGACY_S3_CONFIG');
    result.LEGACY_S3_REGION=source.LEGACY_S3_REGION||'auto';
    if(!/^[a-z0-9-]{1,64}$/.test(result.LEGACY_S3_REGION))throw new Error('INVALID_LEGACY_S3_CONFIG');
    if(source.LEGACY_S3_FORCE_PATH_STYLE!==undefined){
      if(!['true','false'].includes(source.LEGACY_S3_FORCE_PATH_STYLE))throw new Error('INVALID_LEGACY_S3_CONFIG');
      result.LEGACY_S3_FORCE_PATH_STYLE=source.LEGACY_S3_FORCE_PATH_STYLE;
    }
  }
  return result;
}
