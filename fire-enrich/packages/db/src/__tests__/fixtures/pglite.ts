import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

import * as schema from '../../schema/index.js';

type TestDb = PgliteDatabase<typeof schema>;

export interface TestDbHandle {
  db: TestDb;
  raw: PGlite;
  close: () => Promise<void>;
}

/**
 * DDL for the principals + usage_events tables.
 *
 * Kept inline (rather than running drizzle-kit migrations at test time)
 * so the test fixture has zero filesystem dependencies and starts in
 * milliseconds. The columns/indexes/constraints below MUST stay in sync
 * with `packages/db/src/schema/{principals,usage}.ts`.
 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS principals (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  label                 text NOT NULL,
  token_hash            text NOT NULL UNIQUE,
  token_salt            text NOT NULL,
  token_prefix          text NOT NULL,
  byok_firecrawl_key    text,
  byok_openai_key       text,
  quota_firecrawl_month jsonb,
  quota_openai_month    jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);

CREATE INDEX IF NOT EXISTS principals_token_hash_idx
  ON principals (token_hash);

CREATE TABLE IF NOT EXISTS usage_events (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  scope        text NOT NULL,
  op           text NOT NULL,
  source       text NOT NULL,
  ok           integer NOT NULL,
  units        integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_principal_time_idx
  ON usage_events (principal_id, created_at);
`;

/**
 * Spin up an in-memory Postgres (via PGlite WASM) and return a
 * drizzle client bound to the @fire-enrich/db schema.
 *
 * Each call produces an isolated DB — no shared state between tests.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  const raw = new PGlite({ extensions: { uuid_ossp } });
  await raw.waitReady;

  // PGlite doesn't ship pgcrypto, so we use uuid-ossp's uuid_generate_v4()
  // (loaded via extension) to back the uuid PRIMARY KEY DEFAULTs in the
  // DDL below. raw.exec() (vs db.execute) accepts multi-statement SQL.
  await raw.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  await raw.exec(SCHEMA_DDL);

  const db = drizzle(raw, { schema }) as TestDb;

  return {
    db,
    raw,
    async close() {
      await raw.close();
    },
  };
}
