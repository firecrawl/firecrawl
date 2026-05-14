import { and, eq, gte, sql } from 'drizzle-orm';

import { usageEvents, type UsageEvent } from '../schema/usage.js';

type DrizzleLike = {
  insert: (...args: any[]) => any;
  select: (...args: any[]) => any;
};

export type UsageScope = 'firecrawl' | 'openai';
export type UsageSource = 'byok' | 'pooled';
export type UsageWindow = 'monthToDate';

export interface RecordUsageInput {
  principalId: string;
  scope: UsageScope;
  /** Free-form op label, e.g. "scrape", "crawl", "enrich_row", "chat". */
  op: string;
  source: UsageSource;
  /** 1 for success, 0 for failure. */
  ok: 0 | 1;
  /** Defaults to 1; future-proofed for token/credit accounting. */
  units?: number;
}

export async function recordUsage(
  input: RecordUsageInput,
  db: DrizzleLike,
): Promise<UsageEvent> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      principalId: input.principalId,
      scope: input.scope,
      op: input.op,
      source: input.source,
      ok: input.ok,
      units: input.units ?? 1,
    })
    .returning();
  return row as UsageEvent;
}

/**
 * SUM(units) for events matching (principal, scope, source) within the
 * requested window. Includes both ok=1 and ok=0 events (we count attempts).
 */
export async function sumUsageInWindow(
  principalId: string,
  scope: UsageScope,
  source: UsageSource,
  window: UsageWindow,
  db: DrizzleLike,
): Promise<number> {
  const since = windowStart(window);

  const rows = await db
    .select({ total: sql<string | number>`COALESCE(SUM(${usageEvents.units}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.principalId, principalId),
        eq(usageEvents.scope, scope),
        eq(usageEvents.source, source),
        gte(usageEvents.createdAt, since),
      ),
    );

  // Postgres SUM returns numeric; pg returns it as a string. Normalize.
  const raw = rows[0]?.total ?? 0;
  return typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
}

function windowStart(window: UsageWindow): Date {
  const now = new Date();
  if (window === 'monthToDate') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  // Exhaustiveness check.
  const _exhaustive: never = window;
  return _exhaustive;
}
