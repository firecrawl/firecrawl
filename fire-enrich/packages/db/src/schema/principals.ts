import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const principals = pgTable(
  'principals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    label: text('label').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenSalt: text('token_salt').notNull(),
    tokenPrefix: text('token_prefix').notNull(), // "fe_xxxxxxxx" preview for admin UI
    byokFirecrawlKey: text('byok_firecrawl_key'), // AES-GCM ciphertext, nullable
    byokOpenaiKey: text('byok_openai_key'),
    quotaFirecrawlMonth: jsonb('quota_firecrawl_month').$type<{ limit: number } | null>(),
    quotaOpenaiMonth: jsonb('quota_openai_month').$type<{ limit: number } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHashIdx: index('principals_token_hash_idx').on(t.tokenHash),
  }),
);

export type Principal = typeof principals.$inferSelect;
