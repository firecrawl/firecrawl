import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createTestDb, type TestDbHandle } from '../../__tests__/fixtures/pglite.js';
import { createPrincipal } from '../principals.js';
import { recordUsage, sumUsageInWindow } from '../usage.js';

beforeAll(() => {
  process.env.SERVER_PEPPER = 'test-server-pepper-stable';
  process.env.KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

let h: TestDbHandle;
let principalId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { principal } = await createPrincipal({ label: 'usage-test' }, h.db);
  principalId = principal.id;
});

afterEach(async () => {
  await h.close();
});

describe('recordUsage', () => {
  it('inserts a row with units defaulting to 1', async () => {
    const row = await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 1 },
      h.db,
    );
    expect(row.units).toBe(1);
    expect(row.scope).toBe('firecrawl');
    expect(row.op).toBe('scrape');
    expect(row.source).toBe('pooled');
    expect(row.ok).toBe(1);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('honors an explicit units value', async () => {
    const row = await recordUsage(
      { principalId, scope: 'openai', op: 'enrich_row', source: 'pooled', ok: 1, units: 7 },
      h.db,
    );
    expect(row.units).toBe(7);
  });

  it('records failures (ok=0) just like successes', async () => {
    const row = await recordUsage(
      { principalId, scope: 'firecrawl', op: 'crawl', source: 'pooled', ok: 0 },
      h.db,
    );
    expect(row.ok).toBe(0);
  });
});

describe('sumUsageInWindow', () => {
  it('returns 0 when no events exist', async () => {
    const sum = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(sum).toBe(0);
  });

  it('sums units across all events that match scope+source for this principal', async () => {
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 1 },
      h.db,
    );
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'crawl', source: 'pooled', ok: 1, units: 4 },
      h.db,
    );
    const sum = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(sum).toBe(5);
  });

  it('counts attempts not just successes (ok=0 and ok=1 both included)', async () => {
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 1 },
      h.db,
    );
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 0 },
      h.db,
    );
    const sum = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(sum).toBe(2);
  });

  it('filters by source: BYOK events do not count toward pooled quota', async () => {
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'byok', ok: 1, units: 100 },
      h.db,
    );
    await recordUsage(
      { principalId, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 1, units: 3 },
      h.db,
    );
    const pooled = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(pooled).toBe(3);
    const byok = await sumUsageInWindow(principalId, 'firecrawl', 'byok', 'monthToDate', h.db);
    expect(byok).toBe(100);
  });

  it('filters by scope: openai events do not count toward firecrawl', async () => {
    await recordUsage(
      { principalId, scope: 'openai', op: 'enrich_row', source: 'pooled', ok: 1, units: 10 },
      h.db,
    );
    const firecrawl = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(firecrawl).toBe(0);
    const openai = await sumUsageInWindow(principalId, 'openai', 'pooled', 'monthToDate', h.db);
    expect(openai).toBe(10);
  });

  it('does not include another principal\'s usage', async () => {
    const { principal: other } = await createPrincipal({ label: 'other' }, h.db);
    await recordUsage(
      { principalId: other.id, scope: 'firecrawl', op: 'scrape', source: 'pooled', ok: 1, units: 50 },
      h.db,
    );
    const sum = await sumUsageInWindow(principalId, 'firecrawl', 'pooled', 'monthToDate', h.db);
    expect(sum).toBe(0);
  });
});
