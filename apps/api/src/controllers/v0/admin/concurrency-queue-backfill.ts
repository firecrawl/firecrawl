import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";

/**
 * This controller is deprecated with the migration to FoundationDB.
 *
 * Previously, this was used to backfill the Redis concurrency queue from the
 * PostgreSQL backlog table. With FDB, the backlog is now stored directly in
 * FoundationDB, eliminating the need for synchronization.
 */
export async function concurrencyQueueBackfillController(
  _req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "concurrencyQueueBackfillController",
  });

  logger.info(
    "Concurrency queue backfill is no longer needed with FoundationDB"
  );

  res.json({
    ok: true,
    message:
      "Backfill is no longer needed. The concurrency queue now uses FoundationDB directly.",
  });
}
