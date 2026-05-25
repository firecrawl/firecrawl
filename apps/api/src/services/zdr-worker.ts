import "dotenv/config";
import "./sentry";
import { setSentryServiceTag } from "./sentry";
import { logger } from "../lib/logger";
import { zdrcleaner } from "../lib/zdrcleaner";

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
  setSentryServiceTag("zdr-worker");

  while (!isShuttingDown) {
    await zdrcleaner();
  }

  logger.info("zdr-worker exiting");
  process.exit(0);
})();
