// Kept by a mounted reader only; never persisted or shared between sessions.
export function createReaderCache({maxEntries=8,maxBytes=4*1024*1024,ttl=60000,now=Date.now}={}) {
    const entries=new Map();let bytes=0;
    function remove(key){const item=entries.get(key);if(item){bytes-=item.size;entries.delete(key);}}
    return {
        get(key){const item=entries.get(key);if(!item)return;if(now()-item.time>=ttl){remove(key);return;}entries.delete(key);entries.set(key,item);return item.value;},
        set(key,value){remove(key);const size=new TextEncoder().encode(JSON.stringify(value)).byteLength;if(size>maxBytes)return;while(entries.size&&(entries.size>=maxEntries||bytes+size>maxBytes))remove(entries.keys().next().value);entries.set(key,{value,size,time:now()});bytes+=size;},
        clear(){entries.clear();bytes=0;},
    };
}
