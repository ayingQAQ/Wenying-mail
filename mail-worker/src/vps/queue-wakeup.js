// A latched signal avoids losing notifications received during processing.
// Coalesce bursts and keep a short fast-poll window for delayed R2 events.
export function queueWakeup({now=Date.now,windowMs=60000}={}) {
  let pending=false,until=0,resolve;const hints=new Map();
  return {
    offer(reference){if(hints.size<64||hints.has(reference.deliveryId))hints.set(reference.deliveryId,reference);},
    take(){const id=hints.keys().next().value;if(id===undefined)return;const value=hints.get(id);hints.delete(id);return value;},
    wake(){pending=true;until=now()+windowMs;resolve?.();},
    async wait(delay,signal){
      if(signal.aborted)return;
      if(pending){pending=false;return;}
      await new Promise(done=>{
        const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve=undefined;done();};
        const timer=setTimeout(finish,now()<until?Math.min(delay,1000):delay);
        resolve=finish;signal.addEventListener('abort',finish,{once:true});
      });
      pending=false;
    },
  };
}
