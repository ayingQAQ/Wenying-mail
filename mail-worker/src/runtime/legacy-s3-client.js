import {S3Client} from '@aws-sdk/client-s3';

export function legacyS3Client(env){
  const pathStyle=env.LEGACY_S3_FORCE_PATH_STYLE??'true';
  if(!['true','false'].includes(pathStyle))throw new Error('LEGACY_STORAGE_UNAVAILABLE');
  const endpoint=new URL(env.LEGACY_S3_ENDPOINT);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
    !env.LEGACY_S3_BUCKET||!env.LEGACY_S3_ACCESS_KEY_ID||!env.LEGACY_S3_SECRET_ACCESS_KEY)throw new Error('LEGACY_STORAGE_UNAVAILABLE');
  const client=new S3Client({endpoint:endpoint.href,region:env.LEGACY_S3_REGION||'auto',forcePathStyle:pathStyle==='true',maxAttempts:1,
    credentials:{accessKeyId:env.LEGACY_S3_ACCESS_KEY_ID,secretAccessKey:env.LEGACY_S3_SECRET_ACCESS_KEY}});
  return {
    send(command){
      // Workers use the per-call timeout. Node injects its per-job deadline as
      // well, so historical S3 paths cannot outlive an expired background job.
      const signal=typeof env.STORAGE_SIGNAL_FACTORY==='function'?env.STORAGE_SIGNAL_FACTORY(120000):AbortSignal.timeout(120000);
      signal.throwIfAborted();return client.send(command,{abortSignal:signal});
    },
    destroy:()=>client.destroy(),
  };
}
