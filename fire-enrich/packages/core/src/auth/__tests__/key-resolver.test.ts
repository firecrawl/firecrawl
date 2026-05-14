import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@fire-enrich/db';

const decryptKeyMock = vi.fn();

vi.mock('@fire-enrich/db', () => ({
  decryptKey: decryptKeyMock,
}));

const { resolveFirecrawlKey, resolveOpenAIKey, NoKeyAvailableError } =
  await import('../key-resolver.js');

beforeEach(() => decryptKeyMock.mockReset());

afterEach(() => {
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function p(over: Partial<Principal> = {}): Principal {
  return {
    id: 'p1',
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

describe('resolveFirecrawlKey', () => {
  it('returns BYOK source when principal has an encrypted firecrawl key', () => {
    decryptKeyMock.mockReturnValue('fc-byok-decrypted');
    const out = resolveFirecrawlKey(p({ byokFirecrawlKey: 'aes-blob' }));
    expect(out).toEqual({ key: 'fc-byok-decrypted', source: 'byok' });
    expect(decryptKeyMock).toHaveBeenCalledWith('aes-blob');
  });

  it('falls back to pooled FIRECRAWL_API_KEY env when BYOK absent', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-pooled-from-env';
    const out = resolveFirecrawlKey(p());
    expect(out).toEqual({ key: 'fc-pooled-from-env', source: 'pooled' });
  });

  it('throws NoKeyAvailableError when neither BYOK nor pooled is set', () => {
    expect(() => resolveFirecrawlKey(p())).toThrow(NoKeyAvailableError);
  });

  it('prefers BYOK over pooled', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-pooled-from-env';
    decryptKeyMock.mockReturnValue('fc-byok-decrypted');
    const out = resolveFirecrawlKey(p({ byokFirecrawlKey: 'aes-blob' }));
    expect(out.source).toBe('byok');
    expect(out.key).toBe('fc-byok-decrypted');
  });
});

describe('resolveOpenAIKey', () => {
  it('returns BYOK when present', () => {
    decryptKeyMock.mockReturnValue('sk-byok');
    const out = resolveOpenAIKey(p({ byokOpenaiKey: 'aes-blob' }));
    expect(out).toEqual({ key: 'sk-byok', source: 'byok' });
  });

  it('falls back to pooled OPENAI_API_KEY env', () => {
    process.env.OPENAI_API_KEY = 'sk-pooled';
    expect(resolveOpenAIKey(p())).toEqual({ key: 'sk-pooled', source: 'pooled' });
  });

  it('throws NoKeyAvailableError when nothing is configured', () => {
    expect(() => resolveOpenAIKey(p())).toThrow(NoKeyAvailableError);
  });
});

describe('NoKeyAvailableError', () => {
  it('has code "no_key_available" and a scoped message', () => {
    const err = new NoKeyAvailableError('firecrawl');
    expect(err.code).toBe('no_key_available');
    expect(err.scope).toBe('firecrawl');
    expect(err.message).toMatch(/firecrawl/);
  });
});
