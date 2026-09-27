// This application owns the origin root. Retire only its old Workbox worker/cache.
export async function retireOfflineCache({navigator:nav=navigator,caches:cache=globalThis.caches,origin=location.origin,reload=()=>location.reload()}={}) {
  if (!nav.serviceWorker) return;
  const registrations=await nav.serviceWorker.getRegistrations();
  const own=url=>{try {const parsed=new URL(url);return parsed.origin===origin && parsed.pathname==='/sw.js';}catch{return false;}};
  const controlled=own(nav.serviceWorker.controller?.scriptURL);
  for (const registration of registrations) {
    if ([registration.active,registration.waiting,registration.installing].some(worker=>worker && own(worker.scriptURL))) {
      if (!await registration.unregister()) throw new Error('OFFLINE_RETIRE_FAILED');
    }
  }
  if (cache) for (const name of await cache.keys()) {
    if (name.startsWith('workbox-') && name.includes(`${origin}/`)) await cache.delete(name);
  }
  if (controlled) { reload(); await new Promise(()=>{}); }
}
