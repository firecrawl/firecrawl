import type { Request } from "express";
import { eq, sql } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("Idempotency key must be a UUID");
  }
}

/** Claim a caller's key before starting a job. A primary-db transaction and
 * per-key advisory lock make the existence check and insert one atomic step,
 * even when the table has no unique constraint on the key column. */
export async function claimIdempotencyKey(req: Request): Promise<boolean> {
  const header = req.headers["x-idempotency-key"];
  const suppliedKey = Array.isArray(header) ? header[0] : header;
  if (!suppliedKey || !isUuid(suppliedKey)) {
    throw new InvalidIdempotencyKeyError();
  }
  // The column is a PostgreSQL UUID. Its text spelling must also be canonical
  // for the advisory lock, or case variants can take different locks.
  const key = suppliedKey.toLowerCase();

  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
    const existing = await tx
      .select({ key: schema.idempotency_keys.key })
      .from(schema.idempotency_keys)
      .where(eq(schema.idempotency_keys.key, key))
      .limit(1);
    if (existing.length > 0) return false;

    await tx.insert(schema.idempotency_keys).values({ key });
    return true;
  });
}
