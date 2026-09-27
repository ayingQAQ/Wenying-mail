export async function commitRaw(bucket, message, owner) {
  const deliveryId = crypto.randomUUID();
  const receivedAt = Date.now();
  const partition = new Date(receivedAt).toISOString().slice(0, 10).replaceAll('-', '/');
  const key = `raw/${partition}/${deliveryId}.eml`;
  const customMetadata = {
    schemaVersion: '1', deliveryId,
    userId: String(owner.userId), accountId: String(owner.accountId),
    envelopeFrom: message.from, envelopeTo: message.to,
    receivedAt: String(receivedAt), rawSize: String(message.rawSize),
  };
  const controller = new AbortController();
  const tasks = [];
  try {
    // Preserve bytes and bound memory; FixedLengthStream also verifies rawSize.
    const stream = new FixedLengthStream(message.rawSize);
    tasks.push(message.raw.pipeTo(stream.writable, { signal: controller.signal }));
    tasks.push(Promise.resolve().then(() => bucket.put(key, stream.readable, {
      customMetadata, httpMetadata: { contentType: 'message/rfc822' },
      onlyIf: { etagDoesNotMatch: '*' },
    })).then(result => { if (!result) throw new Error('RAW_NOT_CREATED'); }));
    await Promise.all(tasks);
  } catch {
    controller.abort();
    await Promise.allSettled(tasks);
    throw new Error('RAW_COMMIT_FAILED');
  }
  return { deliveryId, rawKey: key };
}
