import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
// Reuse the exact bundler already pinned by Wrangler, avoiding another toolchain.
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
await build({entryPoints:{server:fileURLToPath(new URL('../src/vps/server.js',import.meta.url)),application:fileURLToPath(new URL('../src/index.js',import.meta.url))},
  outdir:fileURLToPath(new URL('../dist-vps/',import.meta.url)),outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node22',format:'esm',
  banner:{js:"import {createRequire as __nodeCreateRequire} from 'node:module'; const require=__nodeCreateRequire(import.meta.url);"},
  logLevel:'warning'});
console.log('VPS bundle ready');
