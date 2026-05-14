import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { principals } from '../../schema/index.js';
import { createTestDb, type TestDbHandle } from './pglite.js';

describe('createTestDb()', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('returns a working drizzle client bound to PGlite', async () => {
    const [row] = await handle.db
      .insert(principals)
      .values({
        label: 'fixture-smoke',
        tokenHash: 'h-' + Math.random().toString(36).slice(2),
        tokenSalt: 'salt',
        tokenPrefix: 'fe_smoketst',
      })
      .returning();

    expect(row).toBeDefined();
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    expect(row.label).toBe('fixture-smoke');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.revokedAt).toBeNull();
  });
});
