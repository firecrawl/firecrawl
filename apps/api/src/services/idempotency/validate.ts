import { Request } from "express";
import { eq } from "drizzle-orm";
import { dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { validate as isUuid } from "uuid";
import { logger } from "../../../src/lib/logger";

export async function validateIdempotencyKey(req: Request): Promise<boolean> {
  const idempotencyKey = req.headers["x-idempotency-key"];
  if (!idempotencyKey) {
    // // not returning for missing idempotency key for now
    return true;
  }
  // Ensure idempotencyKey is treated as a string
  const key = Array.isArray(idempotencyKey)
    ? idempotencyKey[0]
    : idempotencyKey;
  if (!isUuid(key)) {
    logger.debug("Invalid idempotency key provided in the request headers.");
    return false;
  }

  let data: { key: string }[] = [];
  try {
    data = await dbRr
      .select({ key: schema.idempotency_keys.key })
      .from(schema.idempotency_keys)
      .where(eq(schema.idempotency_keys.key, key));
  } catch (error) {
    logger.error(`Error validating idempotency key: ${error}`);
  }

  if (!data || data.length === 0) {
    return true;
  }

  return false;
}
