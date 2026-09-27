import { parseBootstrapArgs, readHiddenPassword, readPasswordFromStream } from './bootstrap-input.js';
import { readMigrationFiles } from './migration-files.js';
import { openLocalDatabase } from './local-database.js';
import { applyMigrations } from '../src/database/migrations.js';
import { bootstrapAdmin } from '../src/database/bootstrap-admin.js';

let proxy;
let password;
try {
  const options = parseBootstrapArgs(process.argv.slice(2));
  if (options.passwordStdin) password = await readPasswordFromStream(process.stdin);
  else {
    password = await readHiddenPassword('Administrator password (hidden): ');
    if (password !== await readHiddenPassword('Repeat password (hidden): ')) throw new Error('PASSWORD_CONFIRMATION_MISMATCH');
  }
  proxy = await openLocalDatabase();
  await applyMigrations(proxy.env.db, await readMigrationFiles());
  const result = await bootstrapAdmin(proxy.env.db, { email: options.email, password, loginOnly: options.loginOnly });
  console.log(JSON.stringify({ target: 'local-only', created: result }));
} catch (error) {
  const safe = ['INVALID_BOOTSTRAP_ARGUMENTS', 'INVALID_BOOTSTRAP_INPUT', 'BOOTSTRAP_ALREADY_INITIALIZED',
    'PASSWORD_STDIN_FLAG_REQUIRED', 'INVALID_PASSWORD_INPUT', 'PASSWORD_INPUT_CANCELLED', 'PASSWORD_CONFIRMATION_MISMATCH',
    'MIGRATION_CHECKSUM_MISMATCH', 'UNKNOWN_APPLIED_MIGRATION', 'LEGACY_SCHEMA_REQUIRES_ADOPTION'];
  console.error(safe.includes(error.message) ? error.message : 'LOCAL_BOOTSTRAP_FAILED');
  console.error('Usage: node scripts/bootstrap-admin.js --local --email <address> [--login-only] [--password-stdin]');
  process.exitCode = 1;
} finally {
  password = undefined;
  await proxy?.dispose();
}
