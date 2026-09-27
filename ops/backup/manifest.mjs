const digest=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new Error('INVALID_BACKUP_MANIFEST');};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function fields(value,names) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!names.includes(key)) || names.some(key=>!Object.hasOwn(value,key))) fail();
}
function checksum(value) {fields(value,['size','sha256']);if(!integer(value.size)||!digest.test(value.sha256))fail();}
export function validateBlob(blob) {
  fields(blob,['file','plain','cipher']);
  if(typeof blob.file!=='string' || !blob.file.endsWith('.age') || !uuid.test(blob.file.slice(0,-4)))fail();
  checksum(blob.plain);checksum(blob.cipher);if(blob.cipher.size<blob.plain.size)fail();return blob;
}
function strings(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.entries(value).some(([key,item])=>key.length>1024 || typeof item!=='string' || item.length>16384) || JSON.stringify(value).length>65536)fail();
}
export function validateManifest(manifest) {
  fields(manifest,['version','encryption','snapshotId','snapshotAt','createdAt','appCommit','appSourceSha256','schema','database','objects','deletionLedgerThrough']);
  if(manifest.version!==1 || manifest.encryption!=='age-v1' || !uuid.test(manifest.snapshotId) ||
    !integer(manifest.snapshotAt)||!integer(manifest.createdAt)||manifest.createdAt<manifest.snapshotAt ||
    !integer(manifest.deletionLedgerThrough)||manifest.deletionLedgerThrough<manifest.snapshotAt || manifest.deletionLedgerThrough>manifest.createdAt ||
    !/^[a-f0-9]{40}$/.test(manifest.appCommit)||!digest.test(manifest.appSourceSha256)||manifest.createdAt>8640000000000000)fail();
  if(!Array.isArray(manifest.schema)||!manifest.schema.length)fail();
  for(const [index,migration] of manifest.schema.entries()) {
    fields(migration,['version','checksum']);
    if(!new RegExp(`^${String(index+1).padStart(4,'0')}_[a-z0-9_]+\\.sql$`).test(migration.version)||!digest.test(migration.checksum))fail();
  }
  fields(manifest.database,['bookmark','blob']);
  if(typeof manifest.database.bookmark!=='string'||!manifest.database.bookmark||manifest.database.bookmark.length>1024)fail();
  validateBlob(manifest.database.blob);
  if(!Array.isArray(manifest.objects))fail();
  const objects=new Set(),blobs=new Map();
  const register=blob=>{const description=JSON.stringify(blob);if(blobs.has(blob.file)&&blobs.get(blob.file)!==description)fail();blobs.set(blob.file,description);};
  register(manifest.database.blob);
  for(const object of manifest.objects) {
    fields(object,['backend','key','uploadedAt','customMetadata','httpMetadata','blob']);
    if(!['r2','kv','s3'].includes(object.backend)||typeof object.key!=='string'||!object.key||object.key.length>1024 || /[\x00-\x1f]/.test(object.key)||!integer(object.uploadedAt))fail();
    const identity=JSON.stringify([object.backend,object.key]);if(objects.has(identity))fail();objects.add(identity);
    strings(object.customMetadata);strings(object.httpMetadata);validateBlob(object.blob);register(object.blob);
    // KV preserves application metadata, but has no object HTTP metadata.
    // Reject before sealing a backup or reserving any restore resources.
    if(object.backend==='kv'&&Object.keys(object.httpMetadata).length)fail();
  }
  return manifest;
}

// Pure planning only. No files are removed here. Caller must authenticate and
// decrypt every complete manifest before deciding that a blob is unreferenced.
export function planRetention(snapshots) {
  if(!Array.isArray(snapshots)||snapshots.some(item=>item?.complete!==true))throw new Error('RETENTION_REQUIRES_COMPLETE_SNAPSHOTS');
  const seen=new Set(),descriptors=new Map();
  for(const item of snapshots){
    validateManifest(item.manifest);validateBlob(item.manifestBlob);
    if(seen.has(item.manifest.snapshotId))fail();seen.add(item.manifest.snapshotId);
    for(const blob of [item.manifestBlob,item.manifest.database.blob,...item.manifest.objects.map(object=>object.blob)]) {
      const description=JSON.stringify([blob.plain.size,blob.plain.sha256,blob.cipher.size,blob.cipher.sha256]);
      if(descriptors.has(blob.file)&&descriptors.get(blob.file)!==description)throw new Error('CONFLICTING_RETENTION_BLOB');
      descriptors.set(blob.file,description);
    }
  }
  const ordered=[...snapshots].sort((a,b)=>b.manifest.snapshotAt-a.manifest.snapshotAt || a.manifest.snapshotId.localeCompare(b.manifest.snapshotId));
  const days=new Set(),months=new Set(),keep=[],remove=[];
  for(const item of ordered) {
    const date=new Date(item.manifest.snapshotAt).toISOString(),day=date.slice(0,10),month=date.slice(0,7);
    const daily=days.size<30&&!days.has(day),monthly=months.size<12&&!months.has(month);
    if(daily)days.add(day);if(monthly)months.add(month);
    (daily||monthly?keep:remove).push(item);
  }
  const references=item=>[item.manifestBlob.file,item.manifest.database.blob.file,...item.manifest.objects.map(object=>object.blob.file)];
  const retained=new Set(keep.flatMap(references));
  return {keep:keep.map(item=>item.manifest.snapshotId),remove:remove.map(item=>item.manifest.snapshotId),
    unreferenced:[...new Set(remove.flatMap(references))].filter(file=>!retained.has(file)).sort()};
}
