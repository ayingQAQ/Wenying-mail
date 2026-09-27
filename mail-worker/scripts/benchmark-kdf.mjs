import { performance } from 'node:perf_hooks';
import passwords from '../src/utils/crypto-utils.js';

// A local diagnostic, not a Cloudflare plan/CPU attestation. Never prints credentials.
const samples = [];
for (let index = 0; index < 4; index++) {
  const beforeCpu = process.cpuUsage();
  const beforeTime = performance.now();
  await passwords.hashPassword('benchmark fixture password, not a credential');
  const cpu = process.cpuUsage(beforeCpu);
  samples.push({
    wallMs: Number((performance.now() - beforeTime).toFixed(2)),
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
  });
}
console.log(JSON.stringify({
  environment: `local Node ${process.version}; NOT Cloudflare Workers CPU`,
  algorithm: 'scrypt N=16384 r=8 p=5 dkLen=32',
  firstSampleIsWarmup: true,
  samples,
  freePlanGate: 'UNVERIFIED: run the exact login implementation in authorized staging',
}, null, 2));
