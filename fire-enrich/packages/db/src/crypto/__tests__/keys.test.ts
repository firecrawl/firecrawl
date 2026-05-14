import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decryptKey, encryptKey } from '../keys.js';

const ORIGINAL_KEK = process.env.KEY_ENCRYPTION_KEY;

function freshKekBase64(): string {
  return randomBytes(32).toString('base64');
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(s);
}

describe('encryptKey() / decryptKey()', () => {
  beforeEach(() => {
    process.env.KEY_ENCRYPTION_KEY = freshKekBase64();
  });

  afterEach(() => {
    if (ORIGINAL_KEK === undefined) delete process.env.KEY_ENCRYPTION_KEY;
    else process.env.KEY_ENCRYPTION_KEY = ORIGINAL_KEK;
  });

  it('encryptKey returns a base64 string with iv + ciphertext + authTag concatenated', () => {
    const ciphertext = encryptKey('sk-test');
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(isBase64(ciphertext)).toBe(true);

    // 12 byte IV + 16 byte authTag + at least 1 byte ciphertext = 29 bytes
    // → base64-encoded length >= 40 chars.
    const buf = Buffer.from(ciphertext, 'base64');
    expect(buf.length).toBeGreaterThanOrEqual(12 + 16 + 1);
    // For the given plaintext "sk-test" (7 bytes) we expect exactly 35 bytes.
    expect(buf.length).toBe(12 + 7 + 16);
  });

  it('round-trips: decryptKey(encryptKey(x)) === x', () => {
    const plaintext = 'hello';
    expect(decryptKey(encryptKey(plaintext))).toBe(plaintext);
  });

  it('round-trips longer plaintexts', () => {
    const plaintext = 'sk-proj-' + 'x'.repeat(200);
    expect(decryptKey(encryptKey(plaintext))).toBe(plaintext);
  });

  it('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
    const a = encryptKey('hello');
    const b = encryptKey('hello');
    expect(a).not.toBe(b);
  });

  it('throws when KEY_ENCRYPTION_KEY is unset', () => {
    delete process.env.KEY_ENCRYPTION_KEY;
    expect(() => encryptKey('hello')).toThrow(/KEY_ENCRYPTION_KEY/);
    expect(() => decryptKey('AAAA')).toThrow(/KEY_ENCRYPTION_KEY/);
  });

  it('throws when KEY_ENCRYPTION_KEY is empty', () => {
    process.env.KEY_ENCRYPTION_KEY = '';
    expect(() => encryptKey('hello')).toThrow(/KEY_ENCRYPTION_KEY/);
  });

  it('throws when KEY_ENCRYPTION_KEY has the wrong byte length', () => {
    // 16 random bytes — too short for AES-256.
    process.env.KEY_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encryptKey('hello')).toThrow(/KEY_ENCRYPTION_KEY/);
  });

  it('decryptKey throws when the wrong key is used', () => {
    const ciphertext = encryptKey('hello');
    process.env.KEY_ENCRYPTION_KEY = freshKekBase64();
    expect(() => decryptKey(ciphertext)).toThrow();
  });

  it('decryptKey throws on truncated ciphertext', () => {
    const ciphertext = encryptKey('hello');
    const buf = Buffer.from(ciphertext, 'base64');
    const truncated = buf.subarray(0, buf.length - 4).toString('base64');
    expect(() => decryptKey(truncated)).toThrow();
  });

  it('decryptKey throws on tampered ciphertext (flipped byte)', () => {
    const ciphertext = encryptKey('hello world');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the ciphertext region (after 12-byte IV, before authTag).
    buf[buf.length - 17] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptKey(tampered)).toThrow();
  });

  it('decryptKey throws when input is too short to contain iv + authTag', () => {
    expect(() => decryptKey(Buffer.alloc(10).toString('base64'))).toThrow();
  });
});
