import type { Principal } from '@fire-enrich/db';
import { sumUsageInWindow } from '@fire-enrich/db';

export type QuotaScope = 'firecrawl' | 'openai';

export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded' as const;
  readonly scope: QuotaScope;
  readonly limit: number;
  readonly used: number;
  constructor(scope: QuotaScope, limit: number, used: number) {
    super(`Quota exceeded for ${scope}: ${used}/${limit} this month`);
    this.scope = scope;
    this.limit = limit;
    this.used = used;
  }
}

/**
 * Check the principal's monthly pooled-key quota for a scope. Throws
 * QuotaExceededError if the principal has a configured limit and has
 * already met or exceeded it this calendar month.
 *
 * BYOK usage is never checked here; that quota lives upstream at the
 * Firecrawl fork (or at the user's own OpenAI account).
 *
 * `db` is passed through to the repo layer; the type is opaque so this
 * file doesn't take a hard dep on a specific drizzle client shape.
 */
export async function enforceQuota(
  principal: Principal,
  scope: QuotaScope,
  db: unknown,
): Promise<void> {
  const quotaJson =
    scope === 'firecrawl'
      ? principal.quotaFirecrawlMonth
      : principal.quotaOpenaiMonth;
  if (!quotaJson || typeof quotaJson.limit !== 'number') return;

  const used = await sumUsageInWindow(
    principal.id,
    scope,
    'pooled',
    'monthToDate',
    db as never,
  );
  if (used >= quotaJson.limit) {
    throw new QuotaExceededError(scope, quotaJson.limit, used);
  }
}
