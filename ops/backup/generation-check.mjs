import {createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const bad=()=>{throw new Error('BACKUP_GENERATION_INCOMPLETE');};
export async function completeGenerationReferences(references,readObject,signal,assertHold) {
  const map=new Map(references.map(ref=>[JSON.stringify([ref.backend,ref.key]),{...ref}]));
  for(const ref of references.filter(ref=>ref.backend==='r2'&&/^derived\/[^/]+\/[a-f0-9]{64}\/manifest\.json$/.test(ref.key))) {
    await assertHold();signal.throwIfAborted();
    const object=await readObject('r2',ref.key,signal);
    try {
    if(!object?.body||object.size>1024*1024)bad();
    const chunks=[];let size=0;
    for await(const chunk of object.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>1024*1024)bad();chunks.push(bytes);}
    const bytes=Buffer.concat(chunks);if(bytes.length!==object.size)bad();
    let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{bad();}
    const [,delivery,generation]=ref.key.split('/');
    if(manifest.version!==1||manifest.deliveryId!==delivery||manifest.generation!==generation||
      object.customMetadata?.deliveryId!==delivery||object.customMetadata?.generation!==generation||
      typeof manifest.processorVersion!=='string'||!manifest.processorVersion||!Array.isArray(manifest.attachments)||manifest.attachments.length>100||
      generation!==digest(`${manifest.processorVersion}\n${manifest.rawSha256}`))bad();
    const raw=map.get(JSON.stringify(['r2',manifest.rawKey]));if(!raw||raw.sha256!==manifest.rawSha256)bad();
    const entries=[manifest.html,manifest.text,...manifest.attachments];
    if(manifest.html?.key!==`derived/${delivery}/${generation}/body.html`||manifest.text?.key!==`derived/${delivery}/${generation}/body.txt`)bad();
    const declared=new Set();
    for(const entry of entries) {
      if(!entry||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256)||declared.has(entry.key))bad();
      declared.add(entry.key);
      const existing=map.get(JSON.stringify(['r2',entry.key]));if(!existing)bad();
      if(existing.size!==null&&existing.size!==entry.size||existing.sha256!==null&&existing.sha256!==entry.sha256)bad();
      map.set(JSON.stringify(['r2',entry.key]),{...existing,size:entry.size,sha256:entry.sha256});
    }
    for(const attachment of manifest.attachments)if(!new RegExp(`^(attachments|inline)/${delivery}/${generation}/part-[1-9][0-9]*$`).test(attachment.key))bad();
    for(const existing of references)if(existing.backend==='r2'&&new RegExp(`^(attachments|inline)/${delivery}/${generation}/`).test(existing.key)&&!declared.has(existing.key))bad();
    map.set(JSON.stringify(['r2',ref.key]),{...ref,size:bytes.length,sha256:digest(bytes)});
    } finally {await object?.cancel?.();}
  }
  return [...map.values()];
}
