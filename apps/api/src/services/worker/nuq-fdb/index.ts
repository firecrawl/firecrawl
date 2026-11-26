import type { Document } from "../../../controllers/v2/types";
import type { ScrapeJobData } from "../../../types";
import { decodeScrapeJobData, decodeScrapeReturnValue } from "../nuq-decoders";
import { NuQFdbQueue, TypedNuQFdbQueue } from "./queue";
import { NuQFdbJobGroup } from "./groups";
import { NuqFdbSweeper } from "./sweeper";
import { NuqFdbExternalSlots } from "./slots";

export { NuQFdbQueue, QueueFullError, normalizeOwnerId } from "./queue";
export type {
  NuQFdbJob,
  NuQFdbJobOptions,
  NuQFdbGate,
  NuQJobStatusCompat,
} from "./queue";
export { NuQFdbJobGroup } from "./groups";
export type { NuQFdbJobGroupInstance, NuQFdbGroupStatus } from "./groups";
export { NuqFdbSweeper } from "./sweeper";
export { NuqFdbExternalSlots } from "./slots";
export { isFdbConfigured, nuqFdbHealthCheck, withFdbTimeout } from "./client";

export const scrapeQueueFdb = new TypedNuQFdbQueue<
  ScrapeJobData,
  Document | null
>("scrape", {
  hasGroups: true,
  finishedQueueName: "crawl_finished",
  decodeData: decodeScrapeJobData,
  decodeReturnvalue: decodeScrapeReturnValue,
});

export const crawlFinishedQueueFdb = new NuQFdbQueue("crawl_finished", {
  hasGroups: false,
});

if (!scrapeQueueFdb.groupOps) {
  throw new Error("scrapeQueueFdb must be configured with hasGroups: true");
}

export const crawlGroupFdb = new NuQFdbJobGroup(
  scrapeQueueFdb.ks,
  scrapeQueueFdb.groupOps,
);

export const externalSlotsFdb = new NuqFdbExternalSlots(scrapeQueueFdb.ks);

export async function nuqFdbGetMetrics(): Promise<string> {
  const [queueMetrics, workerLoad] = await Promise.all([
    scrapeQueueFdb.getMetrics(),
    scrapeQueueFdb.getWorkerLoadCount(),
  ]);

  return `${queueMetrics}
# HELP firecrawl_nuq_fdb_pending_jobs Number of FDB scrape jobs currently admitted to workers or waiting in ready shards
# TYPE firecrawl_nuq_fdb_pending_jobs gauge
firecrawl_nuq_fdb_pending_jobs ${workerLoad}
`;
}

let sweeper: NuqFdbSweeper | null = null;

export function getNuqFdbSweeper(): NuqFdbSweeper {
  if (!sweeper) {
    sweeper = new NuqFdbSweeper(
      [scrapeQueueFdb, crawlFinishedQueueFdb],
      [externalSlotsFdb],
    );
  }
  return sweeper;
}
