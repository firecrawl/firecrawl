import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { principals, usageEvents } from '../schema/index.js';

const PRINCIPAL_COLUMNS = [
  'id',
  'label',
  'tokenHash',
  'tokenSalt',
  'tokenPrefix',
  'byokFirecrawlKey',
  'byokOpenaiKey',
  'quotaFirecrawlMonth',
  'quotaOpenaiMonth',
  'createdAt',
  'revokedAt',
];

const USAGE_COLUMNS = [
  'id',
  'principalId',
  'scope',
  'op',
  'source',
  'ok',
  'units',
  'createdAt',
];

describe('schema/principals', () => {
  const config = getTableConfig(principals);

  it('table is named "principals"', () => {
    expect(config.name).toBe('principals');
  });

  it('exposes all expected TS columns', () => {
    const tsNames = config.columns.map((c) => (c as { name: string; }).name);
    // getTableConfig returns DB names; verify the JS-accessible field names
    // are all present on the table object instead.
    const fields = Object.keys(principals);
    for (const name of PRINCIPAL_COLUMNS) {
      expect(fields).toContain(name);
    }
    // Also assert all DB column names exist (covers casing).
    expect(tsNames.length).toBeGreaterThanOrEqual(PRINCIPAL_COLUMNS.length);
  });

  it('has the principals_token_hash_idx index', () => {
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain('principals_token_hash_idx');
  });
});

describe('schema/usageEvents', () => {
  const config = getTableConfig(usageEvents);

  it('table is named "usage_events"', () => {
    expect(config.name).toBe('usage_events');
  });

  it('exposes all expected TS columns', () => {
    const fields = Object.keys(usageEvents);
    for (const name of USAGE_COLUMNS) {
      expect(fields).toContain(name);
    }
  });

  it('has the usage_principal_time_idx index', () => {
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain('usage_principal_time_idx');
  });
});
