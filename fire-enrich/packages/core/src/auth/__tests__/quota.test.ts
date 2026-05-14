import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '@fire-enrich/db';

const sumUsageMock = vi.fn();

vi.mock('@fire-enrich/db', () => ({
  sumUsageInWindow: sumUsageMock,
}));

const { enforceQuota, QuotaExceededError } = await import('../quota.js');

afterEach(() => {
  sumUsageMock.mockReset();
});

function principalWith(quotas: Partial<Pick<Principal, 'quotaFirecrawlMonth' | 'quotaOpenaiMonth'>>): Principal {
  return {
    id: 'p1',
    label: 'test',
    tokenHash: 'h',
    tokenSalt: 's',
    tokenPrefix: 'fe_xxxxxxxx',
    byokFirecrawlKey: null,
    byokOpenaiKey: null,
    quotaFirecrawlMonth: null,
    quotaOpenaiMonth: null,
    createdAt: new Date(),
    revokedAt: null,
    ...quotas,
  } as unknown as Principal;
}

describe('enforceQuota — firecrawl scope', () => {
  it('passes (no DB call) when quotaFirecrawlMonth is null', async () => {
    await expect(
      enforceQuota(principalWith({ quotaFirecrawlMonth: null }), 'firecrawl', {} as never),
    ).resolves.toBeUndefined();
    expect(sumUsageMock).not.toHaveBeenCalled();
  });

  it('passes when used < limit', async () => {
    sumUsageMock.mockResolvedValue(99);
    await expect(
      enforceQuota(principalWith({ quotaFirecrawlMonth: { limit: 100 } }), 'firecrawl', {} as never),
    ).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when used === limit', async () => {
    sumUsageMock.mockResolvedValue(100);
    await expect(
      enforceQuota(principalWith({ quotaFirecrawlMonth: { limit: 100 } }), 'firecrawl', {} as never),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('throws QuotaExceededError when used > limit', async () => {
    sumUsageMock.mockResolvedValue(150);
    await expect(
      enforceQuota(principalWith({ quotaFirecrawlMonth: { limit: 100 } }), 'firecrawl', {} as never),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('queries pooled-source month-to-date for the principal', async () => {
    sumUsageMock.mockResolvedValue(0);
    const p = principalWith({ quotaFirecrawlMonth: { limit: 1 } });
    await enforceQuota(p, 'firecrawl', { db: 'fake' } as never);
    expect(sumUsageMock).toHaveBeenCalledWith(
      p.id,
      'firecrawl',
      'pooled',
      'monthToDate',
      { db: 'fake' },
    );
  });
});

describe('enforceQuota — openai scope', () => {
  it('uses quotaOpenaiMonth and the openai scope', async () => {
    sumUsageMock.mockResolvedValue(50);
    await expect(
      enforceQuota(principalWith({ quotaOpenaiMonth: { limit: 50 } }), 'openai', {} as never),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(sumUsageMock).toHaveBeenCalledWith(
      'p1',
      'openai',
      'pooled',
      'monthToDate',
      {},
    );
  });
});

describe('QuotaExceededError shape', () => {
  it('has code "quota_exceeded" and a descriptive message', () => {
    const err = new QuotaExceededError('firecrawl', 100, 150);
    expect(err.code).toBe('quota_exceeded');
    expect(err.message).toMatch(/firecrawl/);
    expect(err.message).toMatch(/100/);
    expect(err.message).toMatch(/150/);
  });
});
