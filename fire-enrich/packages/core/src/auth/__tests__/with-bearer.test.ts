import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@fire-enrich/db';

const findByTokenHashMock = vi.fn();

vi.mock('@fire-enrich/db', () => ({
  findByTokenHash: findByTokenHashMock,
}));

const { withBearer } = await import('../with-bearer.js');

const sample: Principal = {
  id: 'p1',
  label: 't',
  tokenHash: '',
  tokenSalt: '',
  tokenPrefix: '',
  byokFirecrawlKey: null,
  byokOpenaiKey: null,
  quotaFirecrawlMonth: null,
  quotaOpenaiMonth: null,
  createdAt: new Date(),
  revokedAt: null,
} as unknown as Principal;

afterEach(() => findByTokenHashMock.mockReset());

describe('withBearer', () => {
  it('returns a 401 Response when bearer is missing', async () => {
    const handler = withBearer(async (_req, _ctx) => new Response('inner', { status: 200 }));
    const req = new Request('https://x.test/api/foo', { method: 'POST' });
    const res = await handler(req, {} as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('unauthorized');
  });

  it('passes through to the handler with principal in ctx on success', async () => {
    findByTokenHashMock.mockResolvedValue(sample);
    const handler = withBearer<unknown>(async (_req, ctx) => {
      expect(ctx.principal.id).toBe('p1');
      return new Response('ok', { status: 200 });
    });
    const req = new Request('https://x.test/api/foo', {
      method: 'POST',
      headers: { authorization: 'Bearer fe_validtoken_xxxxxxxxxxxxxxxxxxxxx' },
    });
    const res = await handler(req, { db: 'fake' } as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('lets non-Unauthorized errors propagate', async () => {
    findByTokenHashMock.mockResolvedValue(sample);
    const handler = withBearer(async () => {
      throw new Error('boom');
    });
    const req = new Request('https://x.test/api/foo', {
      method: 'POST',
      headers: { authorization: 'Bearer fe_validtoken_xxxxxxxxxxxxxxxxxxxxx' },
    });
    await expect(handler(req, {} as never)).rejects.toThrow('boom');
  });
});
