import type { Request } from "express";
import { eq, sql } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";

/** Claim a caller's key before starting a job. A primary-db transaction and
 * per-key advisory lock make the existence check and insert one atomic step,
 * even when the table has no unique constraint on the key column. */
export async function claimIdempotencyKey(req: Request): Promise<boolean> {
  const header = req.headers["x-idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !isUuid(key)) return false;

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
