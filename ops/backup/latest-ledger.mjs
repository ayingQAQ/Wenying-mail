// R2 tombstones supplement a verified snapshot. A scan cannot prove that every
// newer D1 deletion has reached R2, so it must never advance the coverage cutoff.
export async function supplementLedger({ledger,ledgerThrough,source,signal,maxEntries=100000,now=Date.now()}) {
  const fail=()=>{throw new Error('INVALID_LATEST_LEDGER');};
  if(!Array.isArray(ledger)||!Number.isSafeInteger(ledgerThrough)||ledgerThrough<0||ledgerThrough>now||
    !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>100000)fail();
  const entries=new Map();
  function add(item) {
    if(!item||Object.keys(item).sort().join(',')!=='deletedAt,deliveryId,reasonCode'||
      !/^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|legacy-email-[1-9][0-9]*)$/.test(item.deliveryId)||
      !Number.isSafeInteger(item.deletedAt)||item.deletedAt<0||item.deletedAt>now||!['USER_DELETE','TRASH_EXPIRED','IDENTITY_RETIRED'].includes(item.reasonCode))fail();
    const previous=entries.get(item.deliveryId);
    if(previous&&(previous.deletedAt!==item.deletedAt||previous.reasonCode!==item.reasonCode))fail();
    entries.set(item.deliveryId,item);if(entries.size>maxEntries)fail();
  }
  ledger.forEach(add);let scanned=0;
  for await(const ref of source.inventory(now,signal,['tombstones/'])) {
    signal?.throwIfAborted();if(++scanned>maxEntries||ref.backend!=='r2'||!ref.key.startsWith('tombstones/'))fail();
    const object=await source.readObject('r2',ref.key,signal);
    try {
      if(!Number.isSafeInteger(object.size)||object.size<1||object.size>512)fail();
      let size=0;const chunks=[];
      for await(const chunk of object.body){signal?.throwIfAborted();const bytes=Buffer.from(chunk);size+=bytes.length;if(size>512)fail();chunks.push(bytes);}
      if(size!==object.size)fail();
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!value||value.version!==1||Object.keys(value).sort().join(',')!=='deletedAt,deliveryId,reasonCode,version'||ref.key!==`tombstones/${value.deliveryId}.json`)fail();
      add({deliveryId:value.deliveryId,deletedAt:value.deletedAt,reasonCode:value.reasonCode});
    }finally{await object.cancel?.();}
  }
  return {version:1,ledgerThrough,entries:[...entries.values()].sort((a,b)=>a.deliveryId.localeCompare(b.deliveryId))};
}
