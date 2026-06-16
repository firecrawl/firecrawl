import type { ScrapeJobData } from "../../../types";
import { NuQFdbQueue } from "./queue";
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

export const scrapeQueueFdb = new NuQFdbQueue<ScrapeJobData, any>("scrape", {
  hasGroups: true,
  finishedQueueName: "crawl_finished",
});

export const crawlFinishedQueueFdb = new NuQFdbQueue<any, any>(
  "crawl_finished",
  {
    hasGroups: false,
  },
);

export const crawlGroupFdb = new NuQFdbJobGroup(
  scrapeQueueFdb.ks,
  scrapeQueueFdb.groupOps!,
);

export const externalSlotsFdb = new NuqFdbExternalSlots(scrapeQueueFdb.ks);

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
