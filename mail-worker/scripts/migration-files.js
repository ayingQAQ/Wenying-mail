import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unstable_splitSqlQuery } from 'wrangler';

export async function readMigrationFiles(directory = new URL('../migrations/', import.meta.url)) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async version => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(version)) throw new Error('INVALID_MIGRATION_FILENAME');
    // Git's Windows checkout conversion must not change migration identities.
    const source = (await readFile(new URL(version, directory), 'utf8')).replaceAll('\r\n', '\n');
    return { version, checksum: createHash('sha256').update(source).digest('hex'), queries: unstable_splitSqlQuery(source) };
  }));
}
