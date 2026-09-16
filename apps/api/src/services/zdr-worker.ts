import "dotenv/config";
import { shutdownTracing } from "../otel";
import { logger } from "../lib/logger";
import { cleanZdrRequest, zdrcleaner } from "../lib/zdrcleaner";
import { consumeZdrCleanupJobs, shutdownZdrQueue } from "../lib/zdr-queue";

let isShuttingDown = false;

process.on("SIGINT", () => {
  logger.info("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

(async () => {
  await consumeZdrCleanupJobs(job => cleanZdrRequest(job.requestId));

  while (!isShuttingDown) {
    await zdrcleaner();
  }

  await shutdownZdrQueue();
  await shutdownTracing();
  logger.info("zdr-worker exiting");
  process.exit(0);
})();
