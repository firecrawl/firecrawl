import { config } from "../../../config";
import type { ScrapeJobData } from "../../../types";
import {
  NuQFdbQueue,
  QueueFullError,
  normalizeOwnerId,
  NuqFdbMetricsInitializingError,
} from "./queue";
import { NuQFdbJobGroup } from "./groups";
import { NuqFdbSweeper } from "./sweeper";
import { NuqFdbExternalSlots } from "./slots";
import { NuqFdbPgJobRemovals } from "./pg-removals";
import { isFdbConfigured, nuqFdbHealthCheck, withFdbTimeout } from "./client";
import { nuqFdbMigrationStore } from "./migration-store";

export {
  NuQFdbQueue,
  QueueFullError,
  normalizeOwnerId,
  NuqFdbMetricsInitializingError,
} from "./queue";
export type {
  NuQFdbJob,
  NuQFdbJobOptions,
  NuQFdbGate,
  NuQFdbLegacyJobDescriptor,
  NuQJobStatusCompat,
} from "./queue";
export { NuQFdbJobGroup } from "./groups";
export type { NuQFdbJobGroupInstance, NuQFdbGroupStatus } from "./groups";
export { NuqFdbSweeper } from "./sweeper";
export { NuqFdbExternalSlots, externalSlotMigrationObjectId } from "./slots";
export {
  NuqFdbPgJobRemovals,
  NuqFdbPgJobRemovalConflictError,
} from "./pg-removals";
export type { DurablePgJobRemoval } from "./pg-removals";
export { isFdbConfigured, nuqFdbHealthCheck, withFdbTimeout } from "./client";
export {
  MIGRATION_GC_PAGE_LIMIT,
  MIGRATION_GC_PARTITIONS,
  MIGRATION_RESIDUE_COUNTERS,
  MigrationCasError,
  MigrationCorruptionError,
  MigrationInProgressError,
  MigrationLegacyStateError,
  MigrationOperationConflictError,
  MigrationResidueNotEmptyError,
  MigrationStaleGenerationError,
  MigrationStoreError,
  NuqFdbMigrationStore,
  nuqFdbMigrationStore,
} from "./migration-store";
export type {
  CompletePinnedObjectInput,
  MigrationBackend,
  MigrationGcAuthority,
  MigrationGcBacklog,
  MigrationGcCategory,
  MigrationGcSweepResult,
  MigrationGeneration,
  MigrationGenerationStatus,
  MigrationObjectKind,
  MigrationObjectLastOperation,
  MigrationObjectLifecycle,
  MigrationObjectPin,
  MigrationRecordPin,
  MigrationPhase,
  MigrationPinAdmission,
  MigrationResidue,
  MigrationResidueCounter,
  MigrationSteadyResolution,
  MigrationTeamPinsPage,
  MigrationTeamState,
  PreparePinnedObjectInput,
  ReconcileManagedObjectInput,
  TransitionObjectResidueInput,
} from "./migration-store";

export const scrapeQueueFdb = new NuQFdbQueue<ScrapeJobData, any>("scrape", {
  hasGroups: true,
  finishedQueueName: "crawl_finished",
});

export const crawlFinishedQueueFdb = new NuQFdbQueue<any, any>(
  "crawl_finished",
  {
    hasGroups: false,
    migrationObjectKind: "crawl_finished",
  },
);

export const crawlGroupFdb = new NuQFdbJobGroup(
  scrapeQueueFdb.ks,
  scrapeQueueFdb.groupOps!,
);

export const externalSlotsFdb = new NuqFdbExternalSlots(scrapeQueueFdb.ks);
export const pgJobRemovalsFdb = new NuqFdbPgJobRemovals(nuqFdbMigrationStore);

export async function nuqFdbGetMetrics(): Promise<string> {
  const readiness = `# HELP firecrawl_nuq_fdb_metrics_ready Whether maintained FDB queue metrics are fully initialized
# TYPE firecrawl_nuq_fdb_metrics_ready gauge
`;
  const workerLoadFamily = (workerLoad: number) =>
    `# HELP firecrawl_nuq_fdb_pending_jobs Number of FDB scrape jobs currently admitted to workers or waiting in ready shards
# TYPE firecrawl_nuq_fdb_pending_jobs gauge
firecrawl_nuq_fdb_pending_jobs ${workerLoad}
`;
  if (!config.NUQ_FDB_METRICS_V2_ACTIVATE) {
    return `${readiness}firecrawl_nuq_fdb_metrics_ready 0\n`;
  }
  try {
    const [scrapeQueueMetrics, crawlFinishedQueueMetrics, workerLoad] =
      await Promise.all([
        scrapeQueueFdb.getMetrics(),
        crawlFinishedQueueFdb.getMetrics(),
        scrapeQueueFdb.getWorkerLoadCount(),
      ]);

    return `${readiness}firecrawl_nuq_fdb_metrics_ready 1
${scrapeQueueMetrics}${crawlFinishedQueueMetrics}${workerLoadFamily(workerLoad)}`;
  } catch (error) {
    if (error instanceof NuqFdbMetricsInitializingError) {
      // Release A exposes only readiness. Existing HPA metrics remain absent
      // until the fixed-width generation is exact and READY; rollout holds the
      // current replica floor and freezes new migration cutovers meanwhile.
      return `${readiness}firecrawl_nuq_fdb_metrics_ready 0
`;
    }
    throw error;
  }
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

export function nuqFdbSweeperGetMetrics(): string {
  return getNuqFdbSweeper().getMetrics();
}
