import type { Principal } from '@fire-enrich/db';
import { recordUsage } from '@fire-enrich/db';

import { resolveFirecrawlKey, type ResolvedKey } from './key-resolver.js';
import { enforceQuota } from './quota.js';

export type FirecrawlOp =
  | 'scrape'
  | 'crawl'
  | 'search'
  | 'map'
  | 'extract'
  | 'batch_scrape'
  | 'enrich_row'
  | 'chat'
  | 'job_status'
  | 'cancel_job';

/**
 * Wrap a Firecrawl call with quota + usage accounting.
 *
 * 1. Resolve the key (BYOK | pooled).
 * 2. If pooled, check the principal's monthly quota — throws
 *    QuotaExceededError BEFORE running `fn` so a 429 response can
 *    short-circuit without consuming budget.
 * 3. Run `fn(resolvedKey)` and record one usage_events row with
 *    ok=1 on success or ok=0 on throw. Errors are rethrown.
 *
 * Recording is best-effort: if the DB write fails we log and continue.
 * Losing a usage row is preferable to losing the actual response.
 */
export async function withFirecrawl<T>(
  principal: Principal,
  op: FirecrawlOp,
  db: unknown,
  fn: (key: ResolvedKey) => Promise<T>,
): Promise<T> {
  const resolved = resolveFirecrawlKey(principal);

  if (resolved.source === 'pooled') {
    await enforceQuota(principal, 'firecrawl', db);
  }

  let ok: 0 | 1 = 0;
  try {
    const result = await fn(resolved);
    ok = 1;
    return result;
  } finally {
    await recordUsage(
      {
        principalId: principal.id,
        scope: 'firecrawl',
        op,
        source: resolved.source,
        ok,
      },
      db as never,
    ).catch((err: unknown) => {
      console.error('failed to record firecrawl usage', err);
    });
  }
}
