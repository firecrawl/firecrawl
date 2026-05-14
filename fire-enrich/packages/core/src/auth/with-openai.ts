import type { Principal } from '@fire-enrich/db';
import { recordUsage } from '@fire-enrich/db';

import { resolveOpenAIKey, type ResolvedKey } from './key-resolver.js';
import { enforceQuota } from './quota.js';

export type OpenAIOp = 'enrich_row' | 'chat' | 'generate_fields' | 'synthesis';

export async function withOpenAI<T>(
  principal: Principal,
  op: OpenAIOp,
  db: unknown,
  fn: (key: ResolvedKey) => Promise<T>,
): Promise<T> {
  const resolved = resolveOpenAIKey(principal);

  if (resolved.source === 'pooled') {
    await enforceQuota(principal, 'openai', db);
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
        scope: 'openai',
        op,
        source: resolved.source,
        ok,
      },
      db as never,
    ).catch((err: unknown) => {
      console.error('failed to record openai usage', err);
    });
  }
}
