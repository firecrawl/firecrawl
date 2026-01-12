import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { createHash } from "crypto";
import { config } from "../../config";
import { logger as rootLogger } from "../../lib/logger";
import {
  getCrawlQueueCount,
  isFDBConfigured,
  cleanExpiredJobs,
  cleanExpiredActiveJobs,
  cleanOrphanedClaims,
  sampleTeamCounters,
  sampleCrawlCounters,
  reconcileTeamQueueCounter,
  reconcileCrawlQueueCounter,
  reconcileTeamActiveCounter,
  reconcileCrawlActiveCounter,
  cleanStaleCounters,
} from "../fdb-queue-client";

const logger = rootLogger.child({ module: "nuq-janitor-worker" });

const CRAWL_FINISHED_CHECK_INTERVAL_MS = 15000; // 15 seconds
const CLEANUP_INTERVAL_MS = 60000; // Run cleanup every 60 seconds
const COUNTER_RECONCILIATION_INTERVAL_MS = 300000; // Run counter reconciliation every 5 minutes

// Number of counters to reconcile per interval (keeps each run fast)
const RECONCILIATION_BATCH_SIZE = 20;

// Horizontal scaling configuration
// When multiple janitor workers run, they partition work by crawl ID hash
const TOTAL_PARTITIONS = parseInt(
  process.env.NUQ_JANITOR_TOTAL_PARTITIONS || "1",
  10,
);
const WORKER_PARTITION = parseInt(
  process.env.NUQ_JANITOR_WORKER_PARTITION || "0",
  10,
);

/**
 * Hash a string to a partition number (0 to TOTAL_PARTITIONS-1).
 * Uses consistent hashing so the same ID always maps to the same partition.
 */
function getPartition(id: string): number {
  if (TOTAL_PARTITIONS <= 1) return 0;
  const hash = createHash("md5").update(id).digest();
  // Use first 4 bytes as unsigned int
  const num = hash.readUInt32BE(0);
  return num % TOTAL_PARTITIONS;
}

/**
 * Check if this worker should handle a given ID based on partition.
 */
function shouldHandleId(id: string): boolean {
  return getPartition(id) === WORKER_PARTITION;
}

// Create a dedicated pool for this worker
const nuqPool = new Pool({
  connectionString: config.NUQ_DATABASE_URL,
  application_name: "nuq-janitor-worker",
  max: 5,
});

nuqPool.on("error", err =>
  logger.error("Error in nuq-janitor-worker pool", { error: err }),
);

let isRunning = false;
let crawlFinishedIntervalHandle: NodeJS.Timeout | null = null;
let cleanupIntervalHandle: NodeJS.Timeout | null = null;
let reconciliationIntervalHandle: NodeJS.Timeout | null = null;

// Cursor state for counter reconciliation (to resume where we left off)
let lastTeamId: string | undefined;
let lastCrawlId: string | undefined;

/**
 * Check for finished crawls and mark them as completed.
 * This replaces the PostgreSQL cron job `nuq_group_crawl_finished`.
 *
 * The logic is:
 * 1. Find active crawls (groups) that have no queued/active jobs in PostgreSQL
 * 2. For each candidate, check FoundationDB for remaining backlogged jobs
 * 3. If FDB count is 0, mark the group as completed and insert into crawl_finished queue
 */
async function checkAndMarkFinishedCrawls(): Promise<void> {
  if (!isFDBConfigured()) {
    logger.warn("FDB not configured, skipping crawl finished check");
    return;
  }

  const startTime = Date.now();
  let processedCount = 0;
  let markedFinishedCount = 0;
  let skippedByPartition = 0;

  try {
    // Step 1: Find candidate crawls from PG
    // These are active groups with no queued/active jobs in the main queue.
    // Limit to 200 per iteration (increased since we filter by partition).
    const candidateResult = await nuqPool.query<{
      id: string;
      owner_id: string;
      ttl: number;
    }>(`
      SELECT g.id, g.owner_id, g.ttl
      FROM nuq.group_crawl g
      WHERE g.status = 'active'::nuq.group_status
        AND NOT EXISTS (
          SELECT 1 FROM nuq.queue_scrape s
          WHERE s.group_id = g.id
            AND s.status IN ('active', 'queued')
        )
      LIMIT 200
    `);

    // Filter candidates by partition for horizontal scaling
    const allCandidates = candidateResult.rows;
    const candidates =
      TOTAL_PARTITIONS > 1
        ? allCandidates.filter(c => shouldHandleId(c.id))
        : allCandidates;

    skippedByPartition = allCandidates.length - candidates.length;
    processedCount = candidates.length;

    if (candidates.length === 0) {
      logger.debug("No candidate crawls to check for this partition", {
        partition: WORKER_PARTITION,
        totalPartitions: TOTAL_PARTITIONS,
        skippedByPartition,
      });
      return;
    }

    logger.debug("Found candidate crawls to check", {
      count: candidates.length,
      partition: WORKER_PARTITION,
      totalPartitions: TOTAL_PARTITIONS,
    });

    // Step 2 & 3: For each candidate, check FDB and mark as finished if no backlogged jobs
    for (const candidate of candidates) {
      try {
        const fdbCount = await getCrawlQueueCount(candidate.id);

        if (fdbCount === 0) {
          // No backlogged jobs in FDB - mark as completed
          logger.info("Marking crawl as finished", {
            crawlId: candidate.id,
            ownerId: candidate.owner_id,
          });

          // Use a serializable transaction to prevent race conditions
          // where two workers both see status='active' simultaneously
          const client = await nuqPool.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

            // Update group status to completed
            const updateResult = await client.query(
              `
              UPDATE nuq.group_crawl
              SET status = 'completed'::nuq.group_status,
                  expires_at = now() + MAKE_INTERVAL(secs => $2 / 1000)
              WHERE id = $1 AND status = 'active'::nuq.group_status
              RETURNING id
              `,
              [candidate.id, candidate.ttl],
            );

            if (updateResult.rowCount && updateResult.rowCount > 0) {
              // Insert into crawl_finished queue
              await client.query(
                `
                INSERT INTO nuq.queue_crawl_finished (id, data, owner_id, group_id)
                VALUES ($1, '{}'::jsonb, $2, $3)
                `,
                [uuidv7(), candidate.owner_id, candidate.id],
              );

              markedFinishedCount++;
              logger.info("Crawl marked as finished", {
                crawlId: candidate.id,
              });
            } else {
              logger.debug(
                "Crawl already marked as finished by another worker",
                {
                  crawlId: candidate.id,
                },
              );
            }

            await client.query("COMMIT");
          } catch (txError) {
            await client.query("ROLLBACK");
            throw txError;
          } finally {
            client.release();
          }
        } else {
          logger.debug("Crawl still has backlogged jobs in FDB", {
            crawlId: candidate.id,
            fdbCount,
          });
        }
      } catch (crawlError) {
        logger.error("Error processing candidate crawl", {
          crawlId: candidate.id,
          error: crawlError,
        });
      }
    }
  } catch (error) {
    logger.error("Error checking for finished crawls", { error });
  } finally {
    const duration = Date.now() - startTime;
    if (processedCount > 0 || duration > 1000) {
      logger.debug("Finished checking crawls", {
        processedCount,
        markedFinishedCount,
        durationMs: duration,
      });
    }
  }
}

/**
 * Run FDB cleanup to remove expired jobs and active job entries.
 * This should be called periodically to prevent stale data accumulation.
 */
async function runFDBCleanup(): Promise<void> {
  const startTime = Date.now();
  try {
    const expiredJobsRemoved = await cleanExpiredJobs();
    const expiredActiveJobsRemoved = await cleanExpiredActiveJobs();
    const orphanedClaimsRemoved = await cleanOrphanedClaims();

    if (
      expiredJobsRemoved > 0 ||
      expiredActiveJobsRemoved > 0 ||
      orphanedClaimsRemoved > 0
    ) {
      logger.info("FDB cleanup completed", {
        expiredJobsRemoved,
        expiredActiveJobsRemoved,
        orphanedClaimsRemoved,
        durationMs: Date.now() - startTime,
      });
    }
  } catch (error) {
    logger.error("Error during FDB cleanup", { error });
  }
}

/**
 * Run counter reconciliation to fix any drift between counters and actual data.
 * This runs periodically with a small batch size to minimize performance impact.
 *
 * The reconciliation process:
 * 1. Sample a batch of team/crawl IDs from the counter keyspace
 * 2. For each, compare counter value to actual count
 * 3. If there's a discrepancy, atomically set the correct value
 * 4. Clean up any stale counters (for teams/crawls with no jobs)
 */
async function runCounterReconciliation(): Promise<void> {
  const startTime = Date.now();
  let teamsReconciled = 0;
  let crawlsReconciled = 0;
  let totalCorrections = 0;
  let skippedByPartition = 0;

  try {
    // Reconcile team queue counters
    // Fetch more than batch size to account for partition filtering
    const fetchSize =
      TOTAL_PARTITIONS > 1
        ? RECONCILIATION_BATCH_SIZE * TOTAL_PARTITIONS
        : RECONCILIATION_BATCH_SIZE;
    const allTeamIds = await sampleTeamCounters(fetchSize, lastTeamId);

    // Filter by partition for horizontal scaling
    const teamIds =
      TOTAL_PARTITIONS > 1
        ? allTeamIds
            .filter(id => shouldHandleId(id))
            .slice(0, RECONCILIATION_BATCH_SIZE)
        : allTeamIds;

    skippedByPartition += allTeamIds.length - teamIds.length;

    if (teamIds.length > 0) {
      for (const teamId of teamIds) {
        try {
          const queueCorrection = await reconcileTeamQueueCounter(teamId);
          const activeCorrection = await reconcileTeamActiveCounter(teamId);

          if (queueCorrection !== 0 || activeCorrection !== 0) {
            teamsReconciled++;
            totalCorrections +=
              Math.abs(queueCorrection) + Math.abs(activeCorrection);
          }
        } catch (error) {
          logger.error("Error reconciling team counters", { teamId, error });
        }
      }

      // Update cursor for next run (use the last fetched ID, not the last processed)
      lastTeamId = allTeamIds[allTeamIds.length - 1];

      // If we got fewer than fetch size, we've reached the end - reset cursor
      if (allTeamIds.length < fetchSize) {
        lastTeamId = undefined;
      }
    } else {
      // No more teams, reset cursor
      lastTeamId = undefined;
    }

    // Reconcile crawl queue counters
    const allCrawlIds = await sampleCrawlCounters(fetchSize, lastCrawlId);

    // Filter by partition for horizontal scaling
    const crawlIds =
      TOTAL_PARTITIONS > 1
        ? allCrawlIds
            .filter(id => shouldHandleId(id))
            .slice(0, RECONCILIATION_BATCH_SIZE)
        : allCrawlIds;

    skippedByPartition += allCrawlIds.length - crawlIds.length;

    if (crawlIds.length > 0) {
      for (const crawlId of crawlIds) {
        try {
          const queueCorrection = await reconcileCrawlQueueCounter(crawlId);
          const activeCorrection = await reconcileCrawlActiveCounter(crawlId);

          if (queueCorrection !== 0 || activeCorrection !== 0) {
            crawlsReconciled++;
            totalCorrections +=
              Math.abs(queueCorrection) + Math.abs(activeCorrection);
          }
        } catch (error) {
          logger.error("Error reconciling crawl counters", { crawlId, error });
        }
      }

      // Update cursor for next run (use the last fetched ID, not the last processed)
      lastCrawlId = allCrawlIds[allCrawlIds.length - 1];

      // If we got fewer than fetch size, we've reached the end - reset cursor
      if (allCrawlIds.length < fetchSize) {
        lastCrawlId = undefined;
      }
    } else {
      // No more crawls, reset cursor
      lastCrawlId = undefined;
    }

    // Periodically clean stale counters (only when cursors have reset and only partition 0 does this)
    if (
      lastTeamId === undefined &&
      lastCrawlId === undefined &&
      WORKER_PARTITION === 0
    ) {
      const staleCleaned = await cleanStaleCounters();
      if (staleCleaned > 0) {
        logger.info("Cleaned stale counters during reconciliation", {
          staleCleaned,
        });
      }
    }

    const duration = Date.now() - startTime;
    if (teamsReconciled > 0 || crawlsReconciled > 0 || duration > 1000) {
      logger.info("Counter reconciliation completed", {
        teamsReconciled,
        crawlsReconciled,
        totalCorrections,
        durationMs: duration,
        partition: WORKER_PARTITION,
        totalPartitions: TOTAL_PARTITIONS,
      });
    }
  } catch (error) {
    logger.error("Error during counter reconciliation", { error });
  }
}

/**
 * Start the NuQ janitor worker.
 * This worker runs periodically to:
 * 1. Check for and mark finished crawls
 * 2. Clean up expired jobs from FDB
 * 3. Reconcile FDB counters
 */
export function startNuqJanitorWorker(): void {
  if (isRunning) {
    logger.warn("NuQ janitor worker already running");
    return;
  }

  if (!isFDBConfigured()) {
    logger.info("FDB not configured, not starting NuQ janitor worker");
    return;
  }

  isRunning = true;
  logger.info("Starting NuQ janitor worker", {
    crawlFinishedCheckIntervalMs: CRAWL_FINISHED_CHECK_INTERVAL_MS,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    reconciliationIntervalMs: COUNTER_RECONCILIATION_INTERVAL_MS,
    partition: WORKER_PARTITION,
    totalPartitions: TOTAL_PARTITIONS,
  });

  // Run immediately on startup
  checkAndMarkFinishedCrawls().catch(error => {
    logger.error("Error in initial crawl finished check", { error });
  });

  // Schedule periodic crawl finished checks
  crawlFinishedIntervalHandle = setInterval(() => {
    checkAndMarkFinishedCrawls().catch(error => {
      logger.error("Error in periodic crawl finished check", { error });
    });
  }, CRAWL_FINISHED_CHECK_INTERVAL_MS);

  // Schedule periodic FDB cleanup
  cleanupIntervalHandle = setInterval(() => {
    runFDBCleanup().catch(error => {
      logger.error("Error in FDB cleanup", { error });
    });
  }, CLEANUP_INTERVAL_MS);

  // Schedule periodic counter reconciliation (with a delay to spread out work)
  setTimeout(() => {
    runCounterReconciliation().catch(error => {
      logger.error("Error in initial counter reconciliation", { error });
    });

    reconciliationIntervalHandle = setInterval(() => {
      runCounterReconciliation().catch(error => {
        logger.error("Error in periodic counter reconciliation", { error });
      });
    }, COUNTER_RECONCILIATION_INTERVAL_MS);
  }, 30000); // Start reconciliation 30 seconds after startup
}

/**
 * Stop the NuQ janitor worker.
 */
export async function stopNuqJanitorWorker(): Promise<void> {
  if (!isRunning) {
    return;
  }

  logger.info("Stopping NuQ janitor worker");
  isRunning = false;

  if (crawlFinishedIntervalHandle) {
    clearInterval(crawlFinishedIntervalHandle);
    crawlFinishedIntervalHandle = null;
  }

  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }

  if (reconciliationIntervalHandle) {
    clearInterval(reconciliationIntervalHandle);
    reconciliationIntervalHandle = null;
  }

  await nuqPool.end();
}
