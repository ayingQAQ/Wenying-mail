import { openLocalDatabase } from './local-database.js';
import { readMigrationFiles } from './migration-files.js';
import { legacySchemaContract } from './legacy-schema-profile.js';
import { inspectLegacySchema, adoptLegacySchema } from '../src/database/legacy-adoption.js';

const args = process.argv.slice(2);
let proxy;
try {
  const inspect = args.join(' ') === '--local --inspect';
  const apply = args.length === 5 && args[0] === '--local' && args[1] === '--apply'
    && args[2] === '--writers-stopped' && args[3] === '--expect-schema' && /^[a-f0-9]{64}$/.test(args[4]);
  if (!inspect && !apply) throw new Error('INVALID_ADOPTION_ARGUMENTS');
  const migrations = await readMigrationFiles(), contract = await legacySchemaContract(migrations);
  proxy = await openLocalDatabase();
  const result = inspect ? await inspectLegacySchema(proxy.env.db,contract,migrations)
    : await adoptLegacySchema(proxy.env.db,contract,migrations,{expectedFingerprint:args[4],writersStopped:true});
  console.log(JSON.stringify({target:'local-only',...result}));
  if (inspect && !result.ready) process.exitCode = 1;
} catch(error) {
  const safe = ['INVALID_ADOPTION_ARGUMENTS','ADOPTION_CONTRACT_MISMATCH','ADOPTION_REQUIRES_OFFLINE_REVIEW',
    'ADOPTION_SCHEMA_CHANGED','ADOPTION_PREFLIGHT_FAILED','ADOPTION_TRANSACTION_FAILED','ADOPTION_BATCH_TOO_LARGE'];
  console.error(safe.includes(error.message) ? error.message : 'LOCAL_ADOPTION_FAILED');
  console.error('Usage: node scripts/adopt-legacy.js --local --inspect | --local --apply --writers-stopped --expect-schema <sha256>');
  process.exitCode = 1;
} finally { await proxy?.dispose(); }
