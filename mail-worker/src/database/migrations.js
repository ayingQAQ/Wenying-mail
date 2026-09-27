// Only called by controlled tooling. Never register an HTTP migration endpoint.
export function validateMigrationManifest(migrations) {
  if (!Array.isArray(migrations) || !migrations.length || migrations.some((migration, index) =>
    !new RegExp(`^${String(index + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`).test(migration.version)
    || !/^[a-f0-9]{64}$/.test(migration.checksum)
    || !Array.isArray(migration.queries) || !migration.queries.length
    || migration.queries.some(query => typeof query !== 'string' || !query.trim())
  )) throw new Error('INVALID_MIGRATION_MANIFEST');
}

export async function applyMigrations(db, migrations) {
  validateMigrationManifest(migrations);

  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`).run();
  const applied = (await db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()).results;
  if (!applied.length && migrations[0].version === '0001_baseline.sql') {
    const existing = (await db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','d1_migrations','_cf_METADATA')`).all()).results;
    if (existing.length) throw new Error('LEGACY_SCHEMA_REQUIRES_ADOPTION');
  }
  for (const [index, row] of applied.entries()) {
    const migration = migrations.find(item => item.version === row.version);
    if (!migration) throw new Error('UNKNOWN_APPLIED_MIGRATION');
    if (migration.checksum !== row.checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (migrations[index].version !== row.version) throw new Error('MIGRATION_HISTORY_GAP');
  }
  const completed = [];
  for (const migration of migrations.slice(applied.length)) {
    // D1 batch is a transaction: schema/data changes and the version commit together.
    // A concurrent runner loses the version PK race and rolls its entire batch back.
    await db.batch([
      ...migration.queries.map(query => db.prepare(query)),
      db.prepare('INSERT INTO schema_migrations (version,checksum,applied_at) VALUES (?,?,?)')
        .bind(migration.version, migration.checksum, Date.now()),
    ]);
    completed.push(migration.version);
  }
  return completed;
}
