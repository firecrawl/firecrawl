import type { Principal } from '@fire-enrich/db';

/**
 * Public-facing principal shape returned by /api/admin/principals.
 *
 * NEVER includes the token hash, salt, or BYOK ciphertext — only
 * presence flags. The plaintext token is returned ONCE in the POST
 * response body and never persisted.
 */
export interface PrincipalSummary {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  hasByokFirecrawl: boolean;
  hasByokOpenai: boolean;
  quotaFirecrawlMonth: { limit: number } | null;
  quotaOpenaiMonth: { limit: number } | null;
}

export function toPrincipalSummary(p: Principal): PrincipalSummary {
  return {
    id: p.id,
    label: p.label,
    tokenPrefix: p.tokenPrefix,
    createdAt:
      p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
    revokedAt:
      p.revokedAt instanceof Date
        ? p.revokedAt.toISOString()
        : p.revokedAt
          ? String(p.revokedAt)
          : null,
    hasByokFirecrawl: !!p.byokFirecrawlKey,
    hasByokOpenai: !!p.byokOpenaiKey,
    quotaFirecrawlMonth: p.quotaFirecrawlMonth ?? null,
    quotaOpenaiMonth: p.quotaOpenaiMonth ?? null,
  };
}
