import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from './schema/index.js';

type Db = NodePgDatabase<typeof schema>;

let cachedPool: Pool | null = null;
let cachedDb: Db | null = null;

/**
 * Lazily build a singleton Drizzle client backed by a `pg.Pool`.
 *
 * Reads `DATABASE_URL` from the environment at first call and throws a
 * clear error if it is missing. The Pool itself doesn't open a TCP
 * connection until the first query, so calling `getDb()` is safe at
 * module import time on cold starts.
 */
export function getDb(): Db {
  if (cachedDb) return cachedDb;

  const url = process.env.DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      'DATABASE_URL env var is not set. @fire-enrich/db requires a Postgres connection string.',
    );
  }

  cachedPool = new Pool({ connectionString: url });
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
}

/**
 * Test-only: clear the cached Pool/Db so the next `getDb()` call re-reads
 * `DATABASE_URL`. Not exported from the package entry point.
 */
export function __resetDbForTests(): void {
  cachedPool = null;
  cachedDb = null;
}
