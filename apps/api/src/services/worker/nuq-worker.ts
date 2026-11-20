import "dotenv/config";
import "../../otel";
import { nuqGetLocalMetrics, nuqHealthCheck, scrapeQueue } from "./nuq";
import { runNuqWorker } from "./nuq-worker-runner";
import { startRole } from "../../main";

export async function start() {
  await runNuqWorker({
    serviceName: "nuq-worker",
    queue: scrapeQueue,
    healthCheck: nuqHealthCheck,
    metrics: nuqGetLocalMetrics,
    shutdown: () => scrapeQueue.shutdown(),
  });
}

if (require.main === module) {
  void startRole("nuq-worker");
}
