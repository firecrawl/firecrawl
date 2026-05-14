import type { Principal } from '@fire-enrich/db';
import { decryptKey } from '@fire-enrich/db';

export type KeySource = 'byok' | 'pooled';

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export type KeyScope = 'firecrawl' | 'openai';

export class NoKeyAvailableError extends Error {
  readonly code = 'no_key_available' as const;
  readonly scope: KeyScope;
  constructor(scope: KeyScope) {
    super(
      `No ${scope} key available: principal has no BYOK and no pooled key configured`,
    );
    this.scope = scope;
  }
}

/**
 * Resolve the Firecrawl key for an authenticated principal.
 *
 * Order: BYOK (decrypted from `byok_firecrawl_key`) → pooled
 * `FIRECRAWL_API_KEY` env. Throws NoKeyAvailableError if neither is set.
 *
 * The returned `source` lets callers decide whether to enforce a
 * fire-enrich-side quota (only for `pooled` calls; BYOK is the upstream
 * fork's accounting problem).
 */
export function resolveFirecrawlKey(principal: Principal): ResolvedKey {
  if (principal.byokFirecrawlKey) {
    return { key: decryptKey(principal.byokFirecrawlKey), source: 'byok' };
  }
  const pooled = process.env.FIRECRAWL_API_KEY;
  if (pooled) return { key: pooled, source: 'pooled' };
  throw new NoKeyAvailableError('firecrawl');
}

export function resolveOpenAIKey(principal: Principal): ResolvedKey {
  if (principal.byokOpenaiKey) {
    return { key: decryptKey(principal.byokOpenaiKey), source: 'byok' };
  }
  const pooled = process.env.OPENAI_API_KEY;
  if (pooled) return { key: pooled, source: 'pooled' };
  throw new NoKeyAvailableError('openai');
}
