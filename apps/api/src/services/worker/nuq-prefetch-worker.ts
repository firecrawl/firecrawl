import "dotenv/config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import {
  scrapeQueue,
  nuqGetLocalMetrics,
  nuqHealthCheck,
  nuqShutdown,
  crawlFinishedQueue,
} from "./nuq";
import Express from "express";
import { logger } from "../../lib/logger";

(async () => {
  setSentryServiceTag("nuq-prefetch-worker");

  const app = Express();

  app.get("/metrics", (_, res) =>
    res.contentType("text/plain").send(nuqGetLocalMetrics()),
  );
  app.get("/health", async (_, res) => {
    if (await nuqHealthCheck()) {
      res.status(200).send("OK");
    } else {
      res.status(500).send("Not OK");
    }
  });

  const server = app.listen(
    Number(process.env.NUQ_PREFETCH_WORKER_PORT ?? process.env.PORT ?? 3011),
    () => {
      logger.info("NuQ prefetch worker metrics server started");
    },
  );

  async function shutdown() {
    server.close();
    await nuqShutdown();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  (async () => {
    while (true) {
      await crawlFinishedQueue.prefetchJobs();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  })();

  while (true) {
    await scrapeQueue.prefetchJobs();
    await new Promise(resolve => setTimeout(resolve, 250));
  }
})();
