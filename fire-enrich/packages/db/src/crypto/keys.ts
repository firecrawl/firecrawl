import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for BYOK upstream keys (Firecrawl, OpenAI).
 *
 * Algorithm: AES-256-GCM with a random 12-byte IV per encryption.
 * Output format: base64(iv || ciphertext || authTag).
 *
 * The KEK is loaded from `KEY_ENCRYPTION_KEY` (base64 of 32 random
 * bytes). Calls throw when the env var is missing, empty, or the wrong
 * size — silent fall-through here would let the system run with
 * unauthenticated/weakened crypto.
 */

const KEK_ENV = 'KEY_ENCRYPTION_KEY';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM tag is 128 bits

function loadKek(): Buffer {
  const raw = process.env[KEK_ENV];
  if (!raw || raw.length === 0) {
    throw new Error(`${KEK_ENV} env var not set`);
  }
  let kek: Buffer;
  try {
    kek = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`${KEK_ENV} env var is not valid base64`);
  }
  if (kek.length !== 32) {
    throw new Error(
      `${KEK_ENV} must decode to exactly 32 bytes (got ${kek.length})`,
    );
  }
  return kek;
}

/**
 * Encrypt a plaintext string with AES-256-GCM. Returns base64 of
 * `iv || ciphertext || authTag`.
 */
export function encryptKey(plaintext: string): string {
  const kek = loadKek();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, kek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

/**
 * Decrypt a base64 blob produced by `encryptKey`. Throws on any
 * structural issue (too short) or on auth-tag mismatch (wrong KEK,
 * truncation, tampering).
 */
export function decryptKey(b64: string): string {
  const kek = loadKek();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('ciphertext too short to contain iv + authTag');
  }
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);

  const decipher = createDecipheriv(ALGO, kek, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
