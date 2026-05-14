import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@fire-enrich/db';

const decryptKeyMock = vi.fn();
const sumUsageMock = vi.fn();
const recordUsageMock = vi.fn();

vi.mock('@fire-enrich/db', () => ({
  decryptKey: decryptKeyMock,
  sumUsageInWindow: sumUsageMock,
  recordUsage: recordUsageMock,
}));

const { withFirecrawl } = await import('../with-firecrawl.js');
const { withOpenAI } = await import('../with-openai.js');
const { QuotaExceededError } = await import('../quota.js');

beforeEach(() => {
  decryptKeyMock.mockReset();
  sumUsageMock.mockReset();
  recordUsageMock.mockReset();
  recordUsageMock.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function p(over: Partial<Principal> = {}): Principal {
  return {
    id: 'p-test',
    label: 'x',
    tokenHash: '',
    tokenSalt: '',
    tokenPrefix: '',
    byokFirecrawlKey: null,
    byokOpenaiKey: null,
    quotaFirecrawlMonth: null,
    quotaOpenaiMonth: null,
    createdAt: new Date(),
    revokedAt: null,
    ...over,
  } as unknown as Principal;
}

describe('withFirecrawl', () => {
  it('passes the resolved key to the inner fn and records ok=1 on success', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-pooled';
    const result = await withFirecrawl(
      p(),
      'scrape',
      { db: 'fake' } as never,
      async (key) => `got:${key.key}/${key.source}`,
    );
    expect(result).toBe('got:fc-pooled/pooled');
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'p-test',
        scope: 'firecrawl',
        op: 'scrape',
        source: 'pooled',
        ok: 1,
      }),
      { db: 'fake' },
    );
  });

  it('records ok=0 when the inner fn throws, then rethrows', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-pooled';
    await expect(
      withFirecrawl(p(), 'crawl', {} as never, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: 0, op: 'crawl' }),
      expect.anything(),
    );
  });

  it('enforces quota only when source is pooled', async () => {
    decryptKeyMock.mockReturnValue('fc-byok');
    sumUsageMock.mockResolvedValue(99999);
    const principal = p({
      byokFirecrawlKey: 'aes',
      quotaFirecrawlMonth: { limit: 1 } as never,
    });
    // Even though sum is way over the limit, BYOK skips quota.
    const out = await withFirecrawl(principal, 'scrape', {} as never, async () => 'ok');
    expect(out).toBe('ok');
    expect(sumUsageMock).not.toHaveBeenCalled();
  });

  it('throws QuotaExceededError BEFORE calling fn when pooled+over-quota', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-pooled';
    sumUsageMock.mockResolvedValue(100);
    const innerSpy = vi.fn();
    await expect(
      withFirecrawl(
        p({ quotaFirecrawlMonth: { limit: 100 } as never }),
        'scrape',
        {} as never,
        innerSpy,
      ),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(innerSpy).not.toHaveBeenCalled();
    // No usage recorded when we 429 before the call
    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});

describe('withOpenAI', () => {
  it('uses the openai scope and pooled OPENAI_API_KEY env', async () => {
    process.env.OPENAI_API_KEY = 'sk-pooled';
    sumUsageMock.mockResolvedValue(0);
    const result = await withOpenAI(
      p(),
      'enrich_row',
      {} as never,
      async (key) => key.key,
    );
    expect(result).toBe('sk-pooled');
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'openai', op: 'enrich_row', source: 'pooled', ok: 1 }),
      expect.anything(),
    );
  });
});
