import { admitMailbox } from './mailbox-admission.js';
import { commitRaw } from './raw-store.js';
import { notifyVps } from './notify-vps.js';

export async function receive(message, env, ctx) {
  const owner = await admitMailbox(env.db, message.to);
  if (!owner) {
    message.setReject('Recipient unavailable');
    return;
  }
  if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 0 ||
      typeof message.from !== 'string' || message.from.length > 254 ||
      /[^\x21-\x7e]/.test(message.from)) throw new Error('INVALID_ENVELOPE');
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject('Message exceeds size limit');
    return;
  }
  // The awaited PUT is the commit point. R2 notifications/reconciliation schedule
  // processing separately; no D1 write or queue availability is needed afterward.
  await commitRaw(env.r2, message, owner);
  // Best effort only after durable commit; notification failure cannot turn an
  // accepted raw object into an SMTP failure or bypass the durable queue.
  // Complete the bounded notification before returning from the email event.
  await notifyVps(env);
}
