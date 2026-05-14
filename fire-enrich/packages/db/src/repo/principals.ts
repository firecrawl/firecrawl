import { and, desc, eq, isNull } from 'drizzle-orm';

import { principals, type Principal } from '../schema/principals.js';
import { encryptKey } from '../crypto/keys.js';
import {
  deriveSalt,
  generateToken,
  hashToken,
  tokenPrefix,
} from '../crypto/tokens.js';

/**
 * Drizzle client shape we accept. Loose typing on purpose so the same
 * code path serves the production pg.Pool client and the in-memory
 * pglite client used by tests.
 */
type DrizzleLike = {
  insert: (...args: any[]) => any;
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete?: (...args: any[]) => any;
};

export interface CreatePrincipalInput {
  label: string;
  byokFirecrawlKey?: string;
  byokOpenaiKey?: string;
  quotaFirecrawlMonth?: { limit: number } | null;
  quotaOpenaiMonth?: { limit: number } | null;
}

export interface CreatePrincipalResult {
  principal: Principal;
  /** Plaintext bearer token. Returned ONCE; never persisted. */
  plaintextToken: string;
}

export async function createPrincipal(
  input: CreatePrincipalInput,
  db: DrizzleLike,
): Promise<CreatePrincipalResult> {
  const plaintextToken = generateToken();
  const prefix = tokenPrefix(plaintextToken);
  const salt = deriveSalt(prefix);
  const hash = hashToken(plaintextToken, salt);

  const [row] = await db
    .insert(principals)
    .values({
      label: input.label,
      tokenHash: hash,
      tokenSalt: salt,
      tokenPrefix: prefix,
      byokFirecrawlKey: input.byokFirecrawlKey
        ? encryptKey(input.byokFirecrawlKey)
        : null,
      byokOpenaiKey: input.byokOpenaiKey
        ? encryptKey(input.byokOpenaiKey)
        : null,
      quotaFirecrawlMonth: input.quotaFirecrawlMonth ?? null,
      quotaOpenaiMonth: input.quotaOpenaiMonth ?? null,
    })
    .returning();

  return { principal: row as Principal, plaintextToken };
}

/**
 * Look up a principal by its plaintext bearer token. Returns null when:
 *  - no row matches, or
 *  - the matching row has been revoked (auth fails closed).
 */
export async function findByTokenHash(
  plaintextToken: string,
  db: DrizzleLike,
): Promise<Principal | null> {
  const prefix = tokenPrefix(plaintextToken);
  const salt = deriveSalt(prefix);
  const hash = hashToken(plaintextToken, salt);

  const rows = await db
    .select()
    .from(principals)
    .where(
      and(eq(principals.tokenHash, hash), isNull(principals.revokedAt)),
    )
    .limit(1);

  return (rows[0] as Principal | undefined) ?? null;
}

export async function listPrincipals(db: DrizzleLike): Promise<Principal[]> {
  const rows = await db
    .select()
    .from(principals)
    .orderBy(desc(principals.createdAt));
  return rows as Principal[];
}

export async function revokePrincipal(
  id: string,
  db: DrizzleLike,
): Promise<Principal | null> {
  // Idempotent: only stamp revokedAt when it's currently null.
  const [updated] = await db
    .update(principals)
    .set({ revokedAt: new Date() })
    .where(and(eq(principals.id, id), isNull(principals.revokedAt)))
    .returning();

  if (updated) return updated as Principal;

  // Either id didn't exist, OR row already revoked. Return current row if any.
  const rows = await db
    .select()
    .from(principals)
    .where(eq(principals.id, id))
    .limit(1);
  return (rows[0] as Principal | undefined) ?? null;
}
