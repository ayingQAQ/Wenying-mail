const applicationNames=['schemaVersion','deliveryId','userId','accountId','envelopeFrom','envelopeTo','receivedAt','rawSize','generation'];
export function metadataNamesMap(mapping={}) {
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new Error('INVALID_R2_METADATA_MAP');
  const names=new Map(applicationNames.map(name=>[name.toLowerCase(),name]));
  for(const [lower,original] of Object.entries(mapping)) {
    if(typeof original!=='string'||!original||original.length>1024||/[\x00-\x1f\x7f]/.test(original)||original.toLowerCase()!==lower||names.has(lower)&&names.get(lower)!==original)
      throw new Error('INVALID_R2_METADATA_MAP');
    names.set(lower,original);
  }
  return names;
}
