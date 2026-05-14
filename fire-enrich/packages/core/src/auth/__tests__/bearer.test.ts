import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@fire-enrich/db';

const findByTokenHashMock = vi.fn();

vi.mock('@fire-enrich/db', () => ({
  findByTokenHash: findByTokenHashMock,
}));

const { requireBearer, UnauthorizedError } = await import('../bearer.js');

const samplePrincipal: Principal = {
  id: 'p1',
  label: 'alice',
  tokenHash: 'h',
  tokenSalt: 's',
  tokenPrefix: 'fe_xxxxxxxx',
  byokFirecrawlKey: null,
  byokOpenaiKey: null,
  quotaFirecrawlMonth: null,
  quotaOpenaiMonth: null,
  createdAt: new Date(),
  revokedAt: null,
} as unknown as Principal;

afterEach(() => findByTokenHashMock.mockReset());

describe('requireBearer', () => {
  it('throws UnauthorizedError when Authorization header missing', async () => {
    const headers = new Headers();
    await expect(requireBearer(headers, {} as never)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws when Authorization is not Bearer', async () => {
    const headers = new Headers({ authorization: 'Basic abc' });
    await expect(requireBearer(headers, {} as never)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws when token does not have the fe_ prefix', async () => {
    const headers = new Headers({ authorization: 'Bearer abc123notatoken' });
    await expect(requireBearer(headers, {} as never)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findByTokenHashMock).not.toHaveBeenCalled(); // fail fast, no DB
  });

  it('throws when DB returns null (token not found or revoked)', async () => {
    findByTokenHashMock.mockResolvedValue(null);
    const headers = new Headers({ authorization: 'Bearer fe_unknowntokenvaluexxxxxxxxxxxxx' });
    await expect(requireBearer(headers, {} as never)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('returns the Principal on success', async () => {
    findByTokenHashMock.mockResolvedValue(samplePrincipal);
    const headers = new Headers({
      authorization: 'Bearer fe_validtoken_aaaaaaaaaaaaaaaaaaaa',
    });
    const p = await requireBearer(headers, {} as never);
    expect(p.id).toBe('p1');
    expect(findByTokenHashMock).toHaveBeenCalledWith(
      'fe_validtoken_aaaaaaaaaaaaaaaaaaaa',
      {},
    );
  });

  it('accepts case-insensitive Bearer prefix', async () => {
    findByTokenHashMock.mockResolvedValue(samplePrincipal);
    const headers = new Headers({ authorization: 'bearer fe_oktoken_xxxxxxxxxxxxxxxxxxxxx' });
    await expect(requireBearer(headers, {} as never)).resolves.toBe(samplePrincipal);
  });
});
