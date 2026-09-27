import { scrypt, timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();
const HASH_PREFIX = 'scrypt$v1$16384$8$5$';
const options = Object.freeze({ N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 });

// Use the Workers native implementation without changing the stored v1 format.
// A native failure must fail the request; never retry with weaker parameters.
async function derive(password, salt) {
  const bytes = encoder.encode(password);
  try {
    return await new Promise((resolve, reject) => {
      scrypt(bytes, salt, 32, options, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { bytes.fill(0); }
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value, length) {
  if (typeof value !== 'string' || value.length > 128) return null;
  try {
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    return bytes.length === length && encode(bytes) === value ? bytes : null;
  } catch { return null; }
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 12
    && password.length <= 1024 && encoder.encode(password).length <= 1024;
}

const saltHashUtils = {
  generateSalt(length = 16) {
    if (!Number.isInteger(length) || length < 16 || length > 64) throw new Error('INVALID_SALT_LENGTH');
    return encode(crypto.getRandomValues(new Uint8Array(length)));
  },

  async hashPassword(password) {
    if (!validPassword(password)) throw new Error('INVALID_PASSWORD');
    const salt = this.generateSalt();
    return { salt, hash: await this.genHashPassword(password, salt) };
  },

  async genHashPassword(password, salt) {
    if (!validPassword(password)) throw new Error('INVALID_PASSWORD');
    const saltBytes = decode(salt, 16);
    if (!saltBytes) throw new Error('INVALID_SALT');
    const derived = await derive(password, saltBytes);
    try { return HASH_PREFIX + encode(derived); }
    finally { derived.fill(0); }
  },

  async verifyPassword(inputPassword, salt, storedHash) {
    if (!validPassword(inputPassword) || typeof storedHash !== 'string' || !storedHash.startsWith(HASH_PREFIX)) return false;
    const saltBytes = decode(salt, 16);
    const expected = decode(storedHash.slice(HASH_PREFIX.length), 32);
    if (!saltBytes || !expected) return false;
    const actual = await derive(inputPassword, saltBytes);
    try { return timingSafeEqual(actual, expected); }
    finally { actual.fill(0); expected.fill(0); }
  },

  genRandomPwd(length = 24) {
    if (!Number.isInteger(length) || length < 12 || length > 128) throw new Error('INVALID_PASSWORD_LENGTH');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    while (result.length < length) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      for (const byte of bytes) {
        // Rejection sampling avoids modulo bias for the 62-character alphabet.
        if (byte >= 248) continue;
        result += chars[byte % 62];
        if (result.length === length) break;
      }
    }
    return result;
  },
};

export default saltHashUtils;
