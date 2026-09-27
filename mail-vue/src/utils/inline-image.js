// Only authenticated raster responses may become data URLs. Never accept sender URLs.
export async function inlineImageUrl(blob) {
  if (!['image/png','image/jpeg','image/gif','image/webp'].includes(blob.type) || blob.size>25*1024*1024) {
    throw new Error('INLINE_TYPE_UNSUPPORTED');
  }
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=8192) binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
