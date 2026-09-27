import { readMigrationFiles } from './migration-files.js';
import { openLocalDatabase } from './local-database.js';
import { applyMigrations } from '../src/database/migrations.js';

if (process.argv.slice(2).join(' ') !== '--local') {
  console.error('Usage: node scripts/migrate.js --local (remote execution is not supported)');
  process.exitCode = 1;
} else {
  let proxy;
  try {
    const migrations = await readMigrationFiles();
    proxy = await openLocalDatabase();
    const applied = await applyMigrations(proxy.env.db, migrations);
    console.log(JSON.stringify({ target: 'local-only', applied }));
  } catch (error) {
    const safe = ['INVALID_MIGRATION_MANIFEST', 'UNKNOWN_APPLIED_MIGRATION', 'MIGRATION_CHECKSUM_MISMATCH', 'MIGRATION_HISTORY_GAP', 'LEGACY_SCHEMA_REQUIRES_ADOPTION'];
    console.error(safe.includes(error.message) ? error.message : 'LOCAL_MIGRATION_FAILED; version not advanced for the failed migration');
    process.exitCode = 1;
  } finally {
    await proxy?.dispose();
  }
}
