import {ListObjectVersionsCommand,DeleteObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';

const pending=()=>new Error('LEGACY_PURGE_PENDING');
const LIMIT=8;

// Restart at the exact key prefix each invocation. Deleting versions changes
// pagination, so never persist a continuation token across deletion batches.
export async function purgeS3Versions(client,target,assertCurrent) {
  async function versions(){
    const page=await client.send(new ListObjectVersionsCommand({Bucket:target.Bucket,Prefix:target.Key,MaxKeys:LIMIT}));
    const values=page.Versions??[],markers=page.DeleteMarkers??[];
    if(page.Name!==target.Bucket||page.Prefix!==target.Key||typeof page.IsTruncated!=='boolean'||
      !Array.isArray(values)||!Array.isArray(markers)||values.length+markers.length>LIMIT||page.CommonPrefixes?.length)throw pending();
    const rows=[...values,...markers],seen=new Set();
    if(page.IsTruncated&&(!rows.length||typeof page.NextKeyMarker!=='string'||!page.NextKeyMarker.startsWith(target.Key)))throw pending();
    for(const row of rows){
      if(typeof row.Key!=='string'||!row.Key.startsWith(target.Key)||/[\x00-\x1f]/.test(row.Key)||
        typeof row.VersionId!=='string'||!row.VersionId||row.VersionId.length>1024||/[\x00-\x1f]/.test(row.VersionId))throw pending();
      const identity=JSON.stringify([row.Key,row.VersionId]);if(seen.has(identity))throw pending();seen.add(identity);
    }
    // S3 lists versions ordered by key. Exact matches precede strict-prefix
    // siblings; those siblings are never deleted, even on a truncated page.
    for(const group of [values,markers])for(let i=1;i<group.length;i++)if(group[i-1].Key>group[i].Key)throw pending();
    return rows.filter(row=>row.Key===target.Key);
  }
  const before=await versions();let deleted=0;
  for(const row of before){
    await assertCurrent();
    // Explicit VersionId also handles the literal "null" version and markers;
    // no unversioned DELETE that could merely create another delete marker.
    await client.send(new DeleteObjectCommand({...target,VersionId:row.VersionId}));deleted++;
  }
  const after=await versions();
  if(after.length)return {pending:true,versionsDeleted:deleted};
  await assertCurrent();
  try{await client.send(new HeadObjectCommand(target));}
  catch(error){if(error.name==='NotFound'&&error.$metadata?.httpStatusCode===404)return {pending:false,versionsDeleted:deleted};throw error;}
  throw pending();
}
