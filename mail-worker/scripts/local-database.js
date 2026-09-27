import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

export async function openLocalDatabase() {
  return getPlatformProxy({
    configPath: fileURLToPath(new URL('./local-bindings.jsonc', import.meta.url)),
    envFiles: [],
    remoteBindings: false,
    persist: { path: fileURLToPath(new URL('../.wrangler/local-admin', import.meta.url)) },
  });
}
