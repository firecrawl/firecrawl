import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { principals } from '../../schema/index.js';
import { createTestDb, type TestDbHandle } from '../../__tests__/fixtures/pglite.js';
import { decryptKey } from '../../crypto/keys.js';
import { hashToken, deriveSalt, tokenPrefix } from '../../crypto/tokens.js';
import {
  createPrincipal,
  findByTokenHash,
  listPrincipals,
  revokePrincipal,
} from '../principals.js';

beforeAll(() => {
  // Stable test secrets — reset only at file scope so module-level
  // tokens.ts/keys.ts pick them up consistently.
  process.env.SERVER_PEPPER = 'test-server-pepper-stable';
  process.env.KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

let h: TestDbHandle;

beforeEach(async () => {
  h = await createTestDb();
});

afterEach(async () => {
  await h.close();
});

describe('createPrincipal', () => {
  it('returns plaintextToken (fe_<...>) and a Principal row that does NOT contain it', async () => {
    const { principal, plaintextToken } = await createPrincipal(
      { label: 'alice' },
      h.db,
    );

    expect(plaintextToken).toMatch(/^fe_[A-Za-z0-9_-]{32}$/);
    expect(principal.label).toBe('alice');
    expect(principal.tokenPrefix).toBe(tokenPrefix(plaintextToken));
    expect(principal.tokenHash).not.toBe(plaintextToken);
    expect(principal.tokenSalt).toBe(deriveSalt(principal.tokenPrefix));
    expect(principal.tokenHash).toBe(
      hashToken(plaintextToken, principal.tokenSalt),
    );
    expect(principal.byokFirecrawlKey).toBeNull();
    expect(principal.byokOpenaiKey).toBeNull();
    expect(principal.revokedAt).toBeNull();
  });

  it('produces distinct tokens and rows on consecutive calls', async () => {
    const a = await createPrincipal({ label: 'a' }, h.db);
    const b = await createPrincipal({ label: 'b' }, h.db);
    expect(a.plaintextToken).not.toBe(b.plaintextToken);
    expect(a.principal.id).not.toBe(b.principal.id);
    expect(a.principal.tokenHash).not.toBe(b.principal.tokenHash);
  });

  it('encrypts BYOK keys with AES-GCM (stores ciphertext, not plaintext)', async () => {
    const { principal } = await createPrincipal(
      {
        label: 'byok',
        byokFirecrawlKey: 'fc-plaintext-secret',
        byokOpenaiKey: 'sk-plaintext-secret',
      },
      h.db,
    );
    expect(principal.byokFirecrawlKey).toBeTruthy();
    expect(principal.byokFirecrawlKey).not.toContain('fc-plaintext-secret');
    expect(decryptKey(principal.byokFirecrawlKey!)).toBe('fc-plaintext-secret');
    expect(decryptKey(principal.byokOpenaiKey!)).toBe('sk-plaintext-secret');
  });

  it('persists optional monthly quotas as JSONB', async () => {
    const { principal } = await createPrincipal(
      {
        label: 'quota',
        quotaFirecrawlMonth: { limit: 1000 },
        quotaOpenaiMonth: { limit: 500 },
      },
      h.db,
    );
    expect(principal.quotaFirecrawlMonth).toEqual({ limit: 1000 });
    expect(principal.quotaOpenaiMonth).toEqual({ limit: 500 });
  });
});

describe('findByTokenHash', () => {
  it('finds a live principal by its plaintext token', async () => {
    const { plaintextToken, principal } = await createPrincipal(
      { label: 'live' },
      h.db,
    );
    const found = await findByTokenHash(plaintextToken, h.db);
    expect(found?.id).toBe(principal.id);
  });

  it('returns null for an unknown token', async () => {
    await createPrincipal({ label: 'noise' }, h.db);
    const found = await findByTokenHash('fe_nonexistent_token_value_xx', h.db);
    expect(found).toBeNull();
  });

  it('returns null for a revoked principal (auth must fail closed)', async () => {
    const { plaintextToken, principal } = await createPrincipal(
      { label: 'doomed' },
      h.db,
    );
    await revokePrincipal(principal.id, h.db);
    const found = await findByTokenHash(plaintextToken, h.db);
    expect(found).toBeNull();
  });
});

describe('listPrincipals', () => {
  it('returns rows newest-first and includes revoked rows', async () => {
    const { principal: p1 } = await createPrincipal({ label: 'one' }, h.db);
    await new Promise((r) => setTimeout(r, 5));
    const { principal: p2 } = await createPrincipal({ label: 'two' }, h.db);
    await revokePrincipal(p1.id, h.db);

    const rows = await listPrincipals(h.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(p2.id); // newer first
    expect(rows[1]!.id).toBe(p1.id);
    expect(rows[1]!.revokedAt).not.toBeNull(); // revoked row still present
  });
});

describe('revokePrincipal', () => {
  it('sets revokedAt to a timestamp; returns the updated row', async () => {
    const { principal } = await createPrincipal({ label: 'r' }, h.db);
    const before = principal.revokedAt;
    expect(before).toBeNull();

    const after = await revokePrincipal(principal.id, h.db);
    expect(after?.revokedAt).toBeInstanceOf(Date);
  });

  it('is idempotent (does not bump revokedAt twice)', async () => {
    const { principal } = await createPrincipal({ label: 'r2' }, h.db);
    const first = await revokePrincipal(principal.id, h.db);
    const t1 = first?.revokedAt?.getTime();
    await new Promise((r) => setTimeout(r, 10));
    const second = await revokePrincipal(principal.id, h.db);
    expect(second?.revokedAt?.getTime()).toBe(t1);
  });

  it('returns null when the id does not exist', async () => {
    const out = await revokePrincipal('00000000-0000-0000-0000-000000000000', h.db);
    expect(out).toBeNull();
  });
});
