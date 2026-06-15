import "dotenv/config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import { nuqGetLocalMetrics, nuqHealthCheck, scrapeQueue } from "./nuq";
import { runNuqWorker } from "./nuq-worker-runner";

(async () => {
  setSentryServiceTag("nuq-worker");

  await runNuqWorker({
    serviceName: "nuq-worker",
    queue: scrapeQueue,
    healthCheck: nuqHealthCheck,
    metrics: nuqGetLocalMetrics,
    shutdown: () => scrapeQueue.shutdown(),
  });
})();
