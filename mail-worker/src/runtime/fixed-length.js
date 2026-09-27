// Workers can convey a native known-length stream to its HTTP implementation.
// Node uses a bounded transform with the same overflow/truncation guarantees.
export function fixedLengthStream(size) {
  if(!Number.isSafeInteger(size)||size<0)throw new Error('INVALID_STREAM_LENGTH');
  if(typeof FixedLengthStream!=='undefined')return new FixedLengthStream(size);
  let seen=0;
  return new TransformStream({
    transform(chunk,controller){
      if(!(chunk instanceof Uint8Array)||seen+chunk.byteLength>size)throw new Error('CONTENT_UNAVAILABLE');
      seen+=chunk.byteLength;controller.enqueue(chunk);
    },
    flush(){if(seen!==size)throw new Error('CONTENT_UNAVAILABLE');},
  });
}
