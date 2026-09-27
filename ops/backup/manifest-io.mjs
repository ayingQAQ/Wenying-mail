import {Writable} from 'node:stream';
import {encryptBlob,decryptBlob} from './age-stream.mjs';
import {validateManifest,validateBlob} from './manifest.mjs';
const MAX_MANIFEST=64*1024*1024;
export async function writeManifest({manifest,...options}) {
  validateManifest(manifest);
  const bytes=Buffer.from(JSON.stringify(manifest));
  if(bytes.length>MAX_MANIFEST)throw new Error('MANIFEST_SIZE_LIMIT');
  return encryptBlob({...options,source:[bytes],maxBytes:MAX_MANIFEST});
}
export async function readManifest({blob,...options}) {
  validateBlob(blob);if(blob.plain.size>MAX_MANIFEST)throw new Error('MANIFEST_SIZE_LIMIT');
  const chunks=[];
  await decryptBlob({...options,blob,destination:new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}})});
  try {return validateManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
  catch {throw new Error('INVALID_BACKUP_MANIFEST');}
}
