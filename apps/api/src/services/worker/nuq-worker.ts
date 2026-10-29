import "dotenv/config";
import "../../otel";
import { nuqGetLocalMetrics, nuqHealthCheck, scrapeQueue } from "./nuq";
import { runNuqWorker } from "./nuq-worker-runner";

(async () => {
  await runNuqWorker({
    serviceName: "nuq-worker",
    queue: scrapeQueue,
    healthCheck: nuqHealthCheck,
    metrics: nuqGetLocalMetrics,
    shutdown: () => scrapeQueue.shutdown(),
  });
})();
