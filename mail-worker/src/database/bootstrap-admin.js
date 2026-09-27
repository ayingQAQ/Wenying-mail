import passwords, { validPassword } from '../utils/crypto-utils.js';

export async function bootstrapAdmin(db, params, allowedDomains = ['pwbing.com']) {
  const email = typeof params?.email === 'string' ? params.email.trim().toLowerCase() : '';
  const [local, domain] = email.split('@');
  if (!/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+$/.test(email) || local.length > 64 || email.length > 254
    || (params?.loginOnly !== undefined && typeof params.loginOnly !== 'boolean')
    || (!params?.loginOnly && !allowedDomains.includes(domain)) || !validPassword(params?.password)) throw new Error('INVALID_BOOTSTRAP_INPUT');
  const history = (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).results;
  if (!history.some(row => row.version === '0001_baseline.sql') || !history.some(row => row.version === '0002_sessions.sql')) {
    throw new Error('BOOTSTRAP_REQUIRES_MIGRATIONS');
  }
  if ((await db.prepare('SELECT COUNT(*) AS count FROM user').first()).count !== 0) throw new Error('BOOTSTRAP_ALREADY_INITIALIZED');
  const { salt, hash } = await passwords.hashPassword(params.password);
  await db.batch([
    // A competing bootstrap makes this NULL and fails the NOT NULL constraint.
    // No existing user's credentials are ever updated, even under concurrent calls.
    db.prepare(`INSERT INTO user(email,type,password,salt)
      VALUES ((SELECT ? WHERE NOT EXISTS (SELECT 1 FROM user)),
        (SELECT role_id FROM role WHERE key='personal-admin'),?,?)`).bind(email, hash, salt),
    ...(params.loginOnly ? [] : [db.prepare('INSERT INTO account(email,user_id,name) SELECT email,user_id,? FROM user WHERE email=?').bind(local, email)]),
    db.prepare(`INSERT INTO audit_logs(actor_user_id,action,target_id,result_code,created_at)
      SELECT user_id,'admin.bootstrap',CAST(user_id AS TEXT),'CREATED',? FROM user WHERE email=?`).bind(Date.now(), email),
  ]);
  return db.prepare('SELECT user_id AS userId,email FROM user WHERE email=?').bind(email).first();
}
