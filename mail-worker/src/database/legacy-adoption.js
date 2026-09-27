import { validateMigrationManifest } from './migrations.js';

// Offline tooling only. No HTTP route and no implicit adoption from applyMigrations.
export const migrationTableSql = `CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
)`;
export const schemaObjectsSql = `SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE name NOT GLOB 'sqlite_*' AND NOT(type='table' AND name IN ('_cf_METADATA','d1_migrations'))
  ORDER BY type,name`;

// Compare audited DDL, not just column names. Ignore whitespace, identifier quoting,
// and column order (old init issued concurrent ALTERs); retain constraints/defaults.
export function ddlSignature(sql, table = false) {
  const tokens = String(sql).match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) || [];
  const normalized = tokens.filter(token => token !== ';').map(token => {
    if (token.startsWith("'")) return token;
    if (/^["`\[]/.test(token)) return token.slice(1, -1).replaceAll('""', '"').toLowerCase();
    return token.toLowerCase();
  });
  if (!table) return JSON.stringify(normalized);
  const start = normalized.indexOf('(');
  if (start < 0 || normalized.at(-1) !== ')') return '';
  const parts = []; let part = [], depth = 0;
  for (const token of normalized.slice(start + 1, -1)) {
    if (token === ',' && depth === 0) { parts.push(JSON.stringify(part)); part = []; continue; }
    if (token === '(') depth++;
    if (token === ')') depth--;
    part.push(token);
  }
  parts.push(JSON.stringify(part));
  return JSON.stringify([normalized.slice(0, start).filter(token => !['if','not','exists'].includes(token)), parts.sort()]);
}

const primaryKeys = { user:'user_id', account:'account_id', email:'email_id', attachments:'att_id',
  star:'star_id', role:'role_id', perm:'perm_id', role_perm:'id', reg_key:'rege_key_id', oauth:'oauth_id', verify_record:'vr_id' };
// SELECT only constants/counts: never transfer bodies, password hashes or large integers.
const checks = [
  ...Object.entries(primaryKeys).map(([table,key]) => [`INVALID_ID_${table.toUpperCase()}`,
    `NOT EXISTS(SELECT 1 FROM "${table}" WHERE typeof("${key}")!='integer' OR "${key}"<1 OR "${key}">999999999999999)`]),
  ['SETTING_CARDINALITY', '(SELECT count(*) FROM setting)=1'],
  ['ACCOUNT_OWNER', 'NOT EXISTS(SELECT 1 FROM account a LEFT JOIN user u ON u.user_id=a.user_id WHERE u.user_id IS NULL)'],
  ['MAIL_OWNER', `NOT EXISTS(SELECT 1 FROM email e LEFT JOIN account a ON a.account_id=e.account_id
    WHERE a.account_id IS NULL OR a.user_id!=e.user_id)`],
  ['ATTACHMENT_OWNER', `NOT EXISTS(SELECT 1 FROM attachments t LEFT JOIN email e ON e.email_id=t.email_id
    WHERE e.email_id IS NULL OR t.user_id!=e.user_id OR t.account_id!=e.account_id)`],
  ['STAR_OWNER', `NOT EXISTS(SELECT 1 FROM star s LEFT JOIN email e ON e.email_id=s.email_id
    WHERE e.email_id IS NULL OR s.user_id!=e.user_id)`],
  ['DUPLICATE_STARS', 'NOT EXISTS(SELECT 1 FROM star GROUP BY user_id,email_id HAVING count(*)>1)'],
  ...['user','account'].map(table => [`DUPLICATE_${table.toUpperCase()}_EMAIL`,
    `NOT EXISTS(SELECT 1 FROM "${table}" GROUP BY email COLLATE NOCASE HAVING count(*)>1)`]),
  ['DUPLICATE_REG_KEY', 'NOT EXISTS(SELECT 1 FROM reg_key GROUP BY code COLLATE NOCASE HAVING count(*)>1)'],
  ['MAIL_STATE', 'NOT EXISTS(SELECT 1 FROM email WHERE unread NOT IN (0,1) OR is_del NOT IN (0,1) OR type NOT IN (0,1))'],
];

async function schemaFingerprint(objects) {
  const bytes = new TextEncoder().encode(JSON.stringify(objects));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b => b.toString(16).padStart(2,'0')).join('');
}

async function inspect(db, contract, migrations) {
  validateMigrationManifest(migrations);
  if (migrations[0].version !== '0001_baseline.sql' || contract.baselineChecksum !== migrations[0].checksum)
    throw new Error('ADOPTION_CONTRACT_MISMATCH');
  const objects = (await db.prepare(schemaObjectsSql).all()).results;
  const history = objects.find(row => row.name === 'schema_migrations');
  const issues = [];
  if (history) {
    if (history.type !== 'table' || ddlSignature(history.sql,true) !== ddlSignature(migrationTableSql,true))
      issues.push('MIGRATION_TABLE_SHAPE');
    else if ((await db.prepare('SELECT count(*) AS n FROM schema_migrations').first()).n !== 0)
      issues.push('ALREADY_VERSIONED');
  }
  const application = objects.filter(row => row.name !== 'schema_migrations');
  const tables = application.filter(row => row.type === 'table');
  const profile = contract.profiles.find(candidate => candidate.tables.length === tables.length && candidate.tables.every(expected =>
    tables.some(actual => actual.name === expected.name && ddlSignature(actual.sql,true) === ddlSignature(expected.sql,true))));
  if (!profile) issues.push('UNSUPPORTED_SCHEMA');
  if (application.some(row => row.type !== 'table' && row.type !== 'index')) issues.push('UNSUPPORTED_SCHEMA_OBJECT');
  if (profile && application.filter(row => row.type === 'index').some(actual => !contract.allowedIndexes.some(expected =>
    actual.name === expected.name && ddlSignature(actual.sql) === ddlSignature(expected.sql)))) issues.push('UNSUPPORTED_INDEX');
  const counts = {};
  if (!issues.length) {
    for (const [code, expression] of checks) {
      if ((await db.prepare(`SELECT (${expression}) AS valid`).first()).valid !== 1) issues.push(code);
    }
    for (const table of tables) counts[table.name] = (await db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).first()).n;
  }
  return { objects, report: { schemaFingerprint:await schemaFingerprint(objects), profile:profile?.name || null,
    baselineChecksum:migrations[0].checksum, ready:issues.length === 0, issues, counts } };
}

export async function inspectLegacySchema(db, contract, migrations) {
  return (await inspect(db,contract,migrations)).report;
}

export async function adoptLegacySchema(db, contract, migrations, { expectedFingerprint, writersStopped } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || '') || writersStopped !== true)
    throw new Error('ADOPTION_REQUIRES_OFFLINE_REVIEW');
  const { objects, report } = await inspect(db,contract,migrations);
  if (report.schemaFingerprint !== expectedFingerprint) throw new Error('ADOPTION_SCHEMA_CHANGED');
  if (!report.ready) throw new Error('ADOPTION_PREFLIGHT_FAILED');
  const guard = '_cloudmail_adoption_guard';
  const statements = [db.prepare(`CREATE TABLE ${guard} (valid INTEGER NOT NULL CHECK(valid=1))`)];
  const assertSql = expression => `INSERT INTO ${guard}(valid) SELECT CASE WHEN (${expression}) THEN 1 ELSE 0 END`;
  // Re-check schema inside the same transaction as the version marker. The new guard
  // is excluded only here; a leftover guard from an unknown runner fails preflight.
  statements.push(db.prepare(assertSql(`(SELECT count(*) FROM (${schemaObjectsSql}) WHERE name!=?)=?`)).bind(guard, objects.length));
  for (const object of objects) statements.push(db.prepare(assertSql(
    'EXISTS(SELECT 1 FROM sqlite_master WHERE type=? AND name=? AND tbl_name=? AND sql IS ?)'
  )).bind(object.type,object.name,object.tbl_name,object.sql));
  if (objects.some(row => row.name === 'schema_migrations'))
    statements.push(db.prepare(assertSql('NOT EXISTS(SELECT 1 FROM schema_migrations)')));
  for (const [,expression] of checks) statements.push(db.prepare(assertSql(expression)));
  // Install baseline indexes, upgrading the old nonunique star index only after
  // validating duplicates. Never discard rows or replay baseline seed INSERTs.
  for (const index of contract.baselineIndexes) {
    const existing = objects.find(row => row.name === index.name);
    if (existing && ddlSignature(existing.sql) === ddlSignature(index.sql)) continue;
    if (existing) statements.push(db.prepare(`DROP INDEX "${index.name}"`));
    statements.push(db.prepare(index.sql));
  }
  if (!objects.some(row => row.name === 'schema_migrations')) statements.push(db.prepare(migrationTableSql));
  statements.push(db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)')
    .bind(migrations[0].version,migrations[0].checksum,Date.now()));
  statements.push(db.prepare(`DROP TABLE ${guard}`));
  if (statements.length > 100) throw new Error('ADOPTION_BATCH_TOO_LARGE');
  try { await db.batch(statements); }
  catch { throw new Error('ADOPTION_TRANSACTION_FAILED'); }
  return { adopted:migrations[0].version, ...report };
}
