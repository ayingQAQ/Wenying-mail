const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RAW_KEY = new RegExp(`^raw/(\\d{4}/\\d{2}/\\d{2})/(${UUID})\\.eml$`);
const MAX_RAW_SIZE = 25 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const size = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_RAW_SIZE;
function keyParts(key) {
  if (typeof key !== 'string') return null;
  const match = RAW_KEY.exec(key);
  if (!match) return null;
  const iso = match[1].replaceAll('/', '-') + 'T00:00:00.000Z';
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) return null;
  return { date: match[1], deliveryId: match[2] };
}

// Decode queue JSON only into an object reference, never into an authorization.
export function decodeProcessingEvent(body, source) {
  if (!source || typeof source.account !== 'string' || !source.account ||
      typeof source.bucket !== 'string' || !source.bucket) throw new Error('QUEUE_SOURCE_UNCONFIGURED');
  const invalid = () => { throw new Error('INVALID_QUEUE_EVENT'); };
  if (!record(body)) return invalid();
  if ('kind' in body || 'version' in body) {
    const parts = keyParts(body.rawKey);
    if (body.version !== 1 || body.kind !== 'process' || !parts ||
        parts.deliveryId !== body.deliveryId ||
        Object.keys(body).some(key => !['version','kind','rawKey','deliveryId'].includes(key))) return invalid();
    return { rawKey: body.rawKey, deliveryId: parts.deliveryId };
  }
  const parts = keyParts(body.object?.key);
  if (body.account !== source.account || body.bucket !== source.bucket ||
      !['PutObject','CopyObject','CompleteMultipartUpload'].includes(body.action) ||
      !record(body.object) || !parts || !size(body.object.size) ||
      typeof body.eventTime !== 'string' || !Number.isFinite(Date.parse(body.eventTime))) return invalid();
  // eTag is intentionally not a raw SHA-256. Hash actual bytes during processing.
  return { rawKey: body.object.key, deliveryId: parts.deliveryId, expectedSize: body.object.size };
}

function integer(value, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= (positive ? 1 : 0) ? number : null;
}
function envelope(value, allowEmpty) {
  return typeof value === 'string' && value.length <= 254 &&
    !/[^\x21-\x7e]/.test(value) && (allowEmpty || /^[^@]+@[^@]+$/.test(value));
}
export async function loadRawDescriptor(bucket, reference) {
  const parts = keyParts(reference?.rawKey);
  if (!parts || reference.deliveryId !== parts.deliveryId) throw new Error('INVALID_QUEUE_EVENT');
  let object;
  try { object = await bucket.head(reference.rawKey); }
  catch { throw new Error('RAW_READ_UNAVAILABLE'); }
  if (!object) throw new Error('RAW_NOT_FOUND');
  return describeRawObject(object, reference);
}

export function describeRawObject(object, reference) {
  const parts = keyParts(reference?.rawKey);
  if (!parts || reference.deliveryId !== parts.deliveryId) throw new Error('INVALID_QUEUE_EVENT');
  const m = object.customMetadata || {};
  const userId = integer(m.userId, true), accountId = integer(m.accountId, true);
  const receivedAt = integer(m.receivedAt, true), rawSize = integer(m.rawSize);
  if (m.schemaVersion !== '1' || m.deliveryId !== parts.deliveryId ||
      userId === null || accountId === null || receivedAt === null || receivedAt > 8640000000000000 ||
      !size(rawSize) || rawSize !== object.size ||
      (reference.expectedSize !== undefined && reference.expectedSize !== rawSize) ||
      !envelope(m.envelopeFrom, true) || !envelope(m.envelopeTo, false) ||
      new Date(receivedAt).toISOString().slice(0,10).replaceAll('-', '/') !== parts.date) {
    throw new Error('INVALID_RAW_METADATA');
  }
  return { deliveryId: parts.deliveryId, rawKey: reference.rawKey, rawSize,
    userId, accountId, receivedAt, envelopeFrom: m.envelopeFrom, envelopeTo: m.envelopeTo };
}
