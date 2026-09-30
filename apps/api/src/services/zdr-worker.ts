import "dotenv/config";
import { shutdownTracing } from "../otel";
import { logger } from "../lib/logger";
import { cleanZdrRequest, sendZdrHeartbeat } from "../lib/zdrcleaner";
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

  // Cleanup is driven entirely by the delayed RabbitMQ queue; this loop only
  // keeps the liveness heartbeat going while the consumer runs.
  while (!isShuttingDown) {
    await sendZdrHeartbeat();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await shutdownZdrQueue();
  await shutdownTracing();
  logger.info("zdr-worker exiting");
  process.exit(0);
})();
