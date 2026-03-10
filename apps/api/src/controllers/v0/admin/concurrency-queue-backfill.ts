import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { reconcileConcurrencyQueue } from "../../../lib/concurrency-queue-reconciler";

export async function concurrencyQueueBackfillController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "concurrencyQueueBackfillController",
  });

  logger.info("Starting concurrency queue backfill");

  const teamId =
    typeof req.query.teamId === "string"
      ? (req.query.teamId as string)
      : undefined;
  const summary = await reconcileConcurrencyQueue({
    teamId,
    logger,
  });

  logger.info("Finished backfilling all teams", summary);

  res.json({ ok: true, ...summary });
}
