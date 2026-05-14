import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { principals } from './principals.js';

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['firecrawl', 'openai'] }).notNull(),
    op: text('op').notNull(), // "scrape" | "crawl" | "search" | "map" | "extract" | "batch_scrape" | "enrich_row" | "chat"
    source: text('source', { enum: ['byok', 'pooled'] }).notNull(),
    ok: integer('ok').notNull(), // 1 or 0
    units: integer('units').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byPrincipalTime: index('usage_principal_time_idx').on(
      t.principalId,
      t.createdAt,
    ),
  }),
);

export type UsageEvent = typeof usageEvents.$inferSelect;
