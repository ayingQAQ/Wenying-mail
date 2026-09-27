import { loadRawDescriptor } from './queue-event.js';

const NOW = `(unixepoch() * 1000)`;
const notDeleted = alias => `NOT EXISTS (SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=${alias}.delivery_id)
  AND NOT EXISTS (SELECT 1 FROM mail_deletion_jobs d WHERE d.delivery_id=${alias}.delivery_id)`;
const ownerMatches = alias => `EXISTS (SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id
  WHERE a.account_id=${alias}.account_id AND a.user_id=${alias}.user_id AND a.email=${alias}.envelope_to COLLATE NOCASE
  AND a.retired_at IS NULL AND u.retired_at IS NULL AND ${alias}.received_at>max(a.retired_through,u.retired_through))`;

export async function registerRaw(db, bucket, reference) {
  // A restored R2 tombstone can exist before its D1 counterpart is restored.
  const raw = await loadRawDescriptor(bucket, reference);
  let tombstone;
  try { tombstone = await bucket.head(`tombstones/${raw.deliveryId}.json`); }
  catch { throw new Error('RAW_READ_UNAVAILABLE'); }
  if (tombstone) return null;
  const values = [raw.deliveryId, raw.rawKey, raw.userId, raw.accountId,
    raw.envelopeFrom, raw.envelopeTo, raw.rawSize, raw.receivedAt];
  const results = await db.batch([
    db.prepare(`INSERT INTO mail_tombstones(delivery_id,deleted_at,reason_code)
      SELECT ?,${NOW},'IDENTITY_RETIRED' FROM account a JOIN user u ON u.user_id=a.user_id
      WHERE a.account_id=? AND a.user_id=? AND (a.retired_at IS NOT NULL OR u.retired_at IS NOT NULL OR ?<=max(a.retired_through,u.retired_through))
      ON CONFLICT(delivery_id) DO NOTHING`).bind(raw.deliveryId,raw.accountId,raw.userId,raw.receivedAt),
    db.prepare(`INSERT INTO mail_deletion_jobs(delivery_id,state,requested_at,updated_at,user_id,account_id,raw_key,storage_version,wait_until)
      SELECT ?,'DELETE_REQUESTED',${NOW},${NOW},?,?,?,'r2-v1',${NOW}+60000
      WHERE EXISTS(SELECT 1 FROM mail_tombstones WHERE delivery_id=?) ON CONFLICT(delivery_id) DO NOTHING`)
      .bind(raw.deliveryId,raw.userId,raw.accountId,raw.rawKey,raw.deliveryId),
    db.prepare(`INSERT INTO mail_processing
      (delivery_id,raw_key,user_id,account_id,envelope_from,envelope_to,raw_size,received_at,state,last_error_code,updated_at)
      SELECT v.*, CASE WHEN ${ownerMatches('v')} THEN 'RECEIVED' ELSE 'QUARANTINED' END,
        CASE WHEN ${ownerMatches('v')} THEN NULL ELSE 'OWNER_MISMATCH' END, ${NOW}
      FROM (SELECT ? AS delivery_id, ? AS raw_key, ? AS user_id, ? AS account_id,
        ? AS envelope_from, ? AS envelope_to, ? AS raw_size, ? AS received_at) v
      WHERE ${notDeleted('v')} ON CONFLICT(delivery_id) DO NOTHING`).bind(...values),
    db.prepare(`SELECT * FROM mail_processing p WHERE delivery_id=? AND ${notDeleted('p')}`).bind(raw.deliveryId),
  ]);
  const row = results[3].results[0] || null;
  if (row && ['delivery_id','raw_key','user_id','account_id','envelope_from','envelope_to','raw_size','received_at']
    .some((key,index) => row[key] !== values[index])) throw new Error('RAW_IDENTITY_CONFLICT');
  return row;
}

export async function claimJob(db, deliveryId, processorVersion) {
  if (typeof processorVersion !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(processorVersion)) throw new Error('INVALID_PROCESSOR_VERSION');
  const results = await db.batch([
    // A crash on the final attempt must not strand the job forever in PROCESSING.
    db.prepare(`UPDATE mail_processing AS p SET state='FAILED',last_error_code='ATTEMPTS_EXHAUSTED',
      lease_owner=NULL,lease_until=0,updated_at=${NOW}
      WHERE delivery_id=? AND state='PROCESSING' AND lease_until<=${NOW}
        AND attempts>=6 AND ${notDeleted('p')}`).bind(deliveryId),
    db.prepare(`UPDATE mail_processing AS p SET state='PROCESSING', attempts=attempts+1,
      lease_owner=?,lease_epoch=lease_epoch+1,lease_until=${NOW}+1200000,
      processor_version=?,updated_at=${NOW}
      WHERE delivery_id=? AND attempts<6 AND next_attempt_at<=${NOW}
        AND (state IN ('RECEIVED','QUEUED','RETRY_WAIT') OR (state='PROCESSING' AND lease_until<=${NOW}))
        AND ${notDeleted('p')} AND ${ownerMatches('p')}
        AND NOT EXISTS (SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE') RETURNING *`)
      .bind(crypto.randomUUID(),processorVersion,deliveryId),
  ]);
  return results[1].results[0] || null;
}

export async function failJob(db, lease, code) {
  if (!['STORAGE_UNAVAILABLE','INVALID_MIME','MIME_LIMIT_EXCEEDED','RAW_INVALID','GENERATION_INVALID','PARSE_UNKNOWN'].includes(code)) throw new Error('INVALID_PROCESSING_ERROR');
  return db.prepare(`UPDATE mail_processing AS p SET
      state=CASE WHEN ? IN ('INVALID_MIME','MIME_LIMIT_EXCEEDED','RAW_INVALID','GENERATION_INVALID') OR (?='PARSE_UNKNOWN' AND parse_failures>=2) THEN 'QUARANTINED'
        WHEN attempts>=6 THEN 'FAILED' ELSE 'RETRY_WAIT' END,
      parse_failures=parse_failures+CASE WHEN ?='PARSE_UNKNOWN' THEN 1 ELSE 0 END,
      next_attempt_at=${NOW}+CASE attempts WHEN 1 THEN 60000 WHEN 2 THEN 300000
        WHEN 3 THEN 900000 WHEN 4 THEN 1800000 ELSE 3600000 END,
      last_error_code=?,lease_owner=NULL,lease_until=0,updated_at=${NOW}
      WHERE delivery_id=? AND state='PROCESSING' AND lease_owner=? AND lease_epoch=?
        AND lease_until>${NOW} AND ${notDeleted('p')} RETURNING *`)
    .bind(code,code,code,code,lease.delivery_id,lease.lease_owner,lease.lease_epoch).first();
}

export async function assertCurrentLease(db, lease) {
  const row=await db.prepare(`SELECT 1 FROM mail_processing p WHERE ${leaseCondition()}`)
    .bind(lease.delivery_id,lease.lease_owner,lease.lease_epoch,lease.processor_version).first();
  if (!row) throw new Error('LEASE_LOST');
}

export function leaseCondition() {
  return `p.delivery_id=? AND p.state='PROCESSING' AND p.lease_owner=? AND p.lease_epoch=?
    AND p.lease_until>${NOW} AND p.processor_version=? AND ${notDeleted('p')} AND ${ownerMatches('p')}`;
}
