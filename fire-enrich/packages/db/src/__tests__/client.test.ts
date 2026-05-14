import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetDbForTests, getDb } from '../client.js';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe('getDb()', () => {
  beforeEach(() => {
    __resetDbForTests();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    __resetDbForTests();
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  it('throws when DATABASE_URL is unset', () => {
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is the empty string', () => {
    process.env.DATABASE_URL = '';
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it('does not throw at construction when DATABASE_URL looks valid (connection is lazy)', () => {
    process.env.DATABASE_URL =
      'postgres://user:pass@127.0.0.1:5432/fire_enrich_test';
    expect(() => getDb()).not.toThrow();
  });

  it('returns the same instance across calls', () => {
    process.env.DATABASE_URL =
      'postgres://user:pass@127.0.0.1:5432/fire_enrich_test';
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });
});
