/**
 * AES-256-GCM encryption for sensitive PII fields (phone, dob).
 * Usage:
 *   const { encrypt, decrypt } = require('./encryption');
 *   const stored = encrypt('9999999999');   // cipher:iv:tag
 *   const plain  = decrypt(stored);         // '9999999999'
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12; // 96-bit recommended for GCM
const TAG_LEN   = 16;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    // Fail loudly outside local dev — a silent fallback here would mean
    // production PII gets encrypted with a key checked into git.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[encryption] ENCRYPTION_KEY is required in production — refusing to start with the insecure dev key.');
    }
    console.warn('[encryption] WARNING: ENCRYPTION_KEY not set — using insecure dev key. Set this in .env for production!');
    return Buffer.from('aivorah-dev-key-do-not-use-in-prod-!!', 'utf8').subarray(0, 32);
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  if (typeof plaintext === 'string' && plaintext.split(':').length === 3) return plaintext;

  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    encrypted.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const parts = String(ciphertext).split(':');
  if (parts.length !== 3) return ciphertext;

  try {
    const [encB64, ivB64, tagB64] = parts;
    const key     = getKey();
    const iv      = Buffer.from(ivB64, 'base64');
    const tag     = Buffer.from(tagB64, 'base64');
    const encData = Buffer.from(encB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { encrypt, decrypt };
