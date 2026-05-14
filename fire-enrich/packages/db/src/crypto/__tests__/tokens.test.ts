import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveSalt,
  generateToken,
  hashToken,
  tokenPrefix,
} from '../tokens.js';

const ORIGINAL_PEPPER = process.env.SERVER_PEPPER;

describe('generateToken()', () => {
  it('returns a string starting with "fe_"', () => {
    const token = generateToken();
    expect(token.startsWith('fe_')).toBe(true);
  });

  it('returns a string at least 27 chars long', () => {
    // fe_ (3) + base64url(24 bytes) = 3 + 32 = 35 chars; lower bound 27.
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(27);
  });

  it('returns the spec-mandated 35 chars (fe_ + base64url of 24 random bytes)', () => {
    const token = generateToken();
    expect(token.length).toBe(35);
  });

  it('returns different tokens on consecutive calls', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('tokenPrefix()', () => {
  it('returns the first 11 characters (fe_ + 8 chars of base64url body)', () => {
    const token = generateToken();
    const prefix = tokenPrefix(token);
    expect(prefix).toBe(token.slice(0, 11));
    expect(prefix.length).toBe(11);
    expect(prefix.startsWith('fe_')).toBe(true);
  });
});

describe('deriveSalt()', () => {
  beforeEach(() => {
    delete process.env.SERVER_PEPPER;
  });

  afterEach(() => {
    if (ORIGINAL_PEPPER === undefined) delete process.env.SERVER_PEPPER;
    else process.env.SERVER_PEPPER = ORIGINAL_PEPPER;
  });

  it('throws a clear error if SERVER_PEPPER is unset', () => {
    expect(() => deriveSalt('fe_abcdefgh')).toThrow(/SERVER_PEPPER/);
  });

  it('throws a clear error if SERVER_PEPPER is empty', () => {
    process.env.SERVER_PEPPER = '';
    expect(() => deriveSalt('fe_abcdefgh')).toThrow(/SERVER_PEPPER/);
  });

  it('is deterministic for the same prefix + pepper', () => {
    process.env.SERVER_PEPPER = 'pepper-one';
    const a = deriveSalt('fe_abcdefgh');
    const b = deriveSalt('fe_abcdefgh');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('returns different salts for different prefixes (same pepper)', () => {
    process.env.SERVER_PEPPER = 'pepper-one';
    const a = deriveSalt('fe_abcdefgh');
    const b = deriveSalt('fe_zzzzzzzz');
    expect(a).not.toBe(b);
  });

  it('returns different salts for different peppers (same prefix)', () => {
    process.env.SERVER_PEPPER = 'pepper-one';
    const a = deriveSalt('fe_abcdefgh');
    process.env.SERVER_PEPPER = 'pepper-two';
    const b = deriveSalt('fe_abcdefgh');
    expect(a).not.toBe(b);
  });
});

describe('hashToken()', () => {
  it('returns a string longer than 30 chars', () => {
    const hash = hashToken('fe_some-test-token-value', 'a-salt');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(30);
  });

  it('is deterministic for the same token + salt', () => {
    const a = hashToken('fe_some-test-token-value', 'a-salt');
    const b = hashToken('fe_some-test-token-value', 'a-salt');
    expect(a).toBe(b);
  });

  it('returns different hashes for different salts', () => {
    const a = hashToken('fe_some-test-token-value', 'salt-one');
    const b = hashToken('fe_some-test-token-value', 'salt-two');
    expect(a).not.toBe(b);
  });

  it('returns different hashes for different tokens', () => {
    const a = hashToken('fe_token-one', 'a-salt');
    const b = hashToken('fe_token-two', 'a-salt');
    expect(a).not.toBe(b);
  });
});
