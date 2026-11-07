import { Request } from "express";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { logger } from "../../../src/lib/logger";

export async function createIdempotencyKey(req: Request): Promise<string> {
  const idempotencyKey = req.headers["x-idempotency-key"] as string;
  if (!idempotencyKey) {
    throw new Error("No idempotency key provided in the request headers.");
  }

  try {
    await db.insert(schema.idempotency_keys).values({ key: idempotencyKey });
  } catch (error) {
    logger.error(`Failed to create idempotency key: ${error}`);
    throw error;
  }

  return idempotencyKey;
}
