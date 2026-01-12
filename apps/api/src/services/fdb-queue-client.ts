/**
 * HTTP client for the FDB Queue microservice.
 *
 * This module provides the same interface as fdb-queue.ts but makes HTTP calls
 * to the separate Rust microservice instead of using the FDB native libraries directly.
 */

import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import { StoredCrawl, getCrawl } from "../lib/crawl-redis";

const logger = rootLogger.child({ module: "fdb-queue-client" });

// Types matching the Rust service
type FDBQueueJob = {
  id: string;
  data: any;
  priority: number;
  listenable: boolean;
  createdAt: number;
  timesOutAt?: number;
  listenChannelId?: string;
  crawlId?: string;
  teamId: string;
};

// Claimed job returned by pop - includes queue key for later completion
type ClaimedJob = {
  job: FDBQueueJob;
  queueKey: string;
};

// Base worker ID for this process (used for logging/debugging)
const baseWorkerId = `worker-${process.pid}-${Date.now().toString(36)}`;

// Generate a unique claim ID for each request to prevent concurrent calls
// from the same process from both thinking they won the same claim
function generateClaimId(): string {
  return `${baseWorkerId}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

// Circuit breaker state for FDB service health
type CircuitState = "closed" | "open" | "half-open";
let circuitState: CircuitState = "closed";
let circuitOpenedAt: number = 0;
let consecutiveFailures: number = 0;
const CIRCUIT_OPEN_DURATION_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

class FDBCircuitOpenError extends Error {
  constructor() {
    super("FDB circuit breaker is open - FDB Queue Service is unavailable");
    this.name = "FDBCircuitOpenError";
  }
}

function checkCircuit(): void {
  if (circuitState === "open") {
    const now = Date.now();
    if (now - circuitOpenedAt >= CIRCUIT_OPEN_DURATION_MS) {
      circuitState = "half-open";
      logger.info("FDB circuit breaker transitioning to half-open");
    } else {
      throw new FDBCircuitOpenError();
    }
  }
}

function recordSuccess(): void {
  if (circuitState === "half-open") {
    circuitState = "closed";
    consecutiveFailures = 0;
    logger.info("FDB circuit breaker closed - FDB Queue Service is healthy");
  } else if (circuitState === "closed") {
    consecutiveFailures = 0;
  }
}

function recordFailure(error: unknown): void {
  consecutiveFailures++;

  if (circuitState === "half-open") {
    circuitState = "open";
    circuitOpenedAt = Date.now();
    logger.error("FDB circuit breaker re-opened after half-open failure", {
      error,
      consecutiveFailures,
    });
  } else if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitState = "open";
    circuitOpenedAt = Date.now();
    logger.error("FDB circuit breaker opened after consecutive failures", {
      error,
      consecutiveFailures,
      threshold: CIRCUIT_FAILURE_THRESHOLD,
    });
  }
}

function getBaseUrl(): string {
  const url = config.FDB_QUEUE_SERVICE_URL;
  if (!url) {
    throw new Error("FDB_QUEUE_SERVICE_URL is not configured");
  }
  return url;
}

async function httpRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: any,
): Promise<T> {
  checkCircuit();

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    recordSuccess();
    return result as T;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

// === Queue Operations ===

export async function pushJob(
  teamId: string,
  job: {
    id: string;
    data: any;
    priority: number;
    listenable: boolean;
    listenChannelId?: string;
  },
  timeout: number,
  crawlId?: string,
): Promise<void> {
  await httpRequest("POST", "/queue/push", {
    teamId,
    job: {
      id: job.id,
      data: job.data,
      priority: job.priority,
      listenable: job.listenable,
      listenChannelId: job.listenChannelId,
    },
    timeout,
    crawlId,
  });

  logger.debug("Pushed job to FDB queue via service", {
    teamId,
    jobId: job.id,
    priority: job.priority,
    crawlId,
  });
}

/**
 * Pop the next available job from the queue.
 *
 * Uses conflict-free versionstamp claims:
 * 1. The service claims a job by writing to a unique versionstamp key
 * 2. Returns a ClaimedJob with job data and a queueKey for completion
 * 3. After processing, call completeJob(queueKey) to remove the job
 *
 * If a worker crashes after claiming but before completing, the orphaned
 * claim will be cleaned up by the janitor, allowing another worker to claim.
 */
export async function popNextJob(
  teamId: string,
  crawlConcurrencyChecker?: (crawlId: string) => Promise<boolean>,
): Promise<ClaimedJob | null> {
  // Try without blocking any crawls first
  return popNextJobWithBlocking(teamId, [], crawlConcurrencyChecker);
}

async function popNextJobWithBlocking(
  teamId: string,
  blockedCrawlIds: string[],
  crawlConcurrencyChecker?: (crawlId: string) => Promise<boolean>,
  claimId?: string,
): Promise<ClaimedJob | null> {
  // Generate a unique claim ID for this request chain (reuse for retries)
  const workerId = claimId ?? generateClaimId();

  const result = await httpRequest<ClaimedJob | null>(
    "POST",
    `/queue/pop/${encodeURIComponent(teamId)}`,
    { workerId, blockedCrawlIds },
  );

  if (result === null) {
    return null;
  }

  // If there's a crawl concurrency checker and the job has a crawl ID,
  // we need to verify concurrency is OK
  if (result.job.crawlId && crawlConcurrencyChecker) {
    const canRun = await crawlConcurrencyChecker(result.job.crawlId);
    if (!canRun) {
      // We claimed this job but can't run it due to crawl concurrency.
      // Release the claim so other workers (or us later) can pick it up.
      logger.debug("Releasing claimed job due to crawl concurrency limit", {
        teamId,
        jobId: result.job.id,
        crawlId: result.job.crawlId,
      });

      await releaseJob(result.job.id);

      // Try again with this crawl blocked
      if (!blockedCrawlIds.includes(result.job.crawlId)) {
        return popNextJobWithBlocking(
          teamId,
          [...blockedCrawlIds, result.job.crawlId],
          crawlConcurrencyChecker,
          workerId, // Reuse the same claim ID for the retry chain
        );
      }
      return null;
    }
  }

  return result;
}

/**
 * Complete a job after successful processing.
 * This removes the job from the queue and cleans up all claims.
 *
 * @param queueKey The base64-encoded queue key from the ClaimedJob
 * @returns true if the job was completed, false if it was already gone
 */
export async function completeJob(queueKey: string): Promise<boolean> {
  const result = await httpRequest<{ success: boolean }>(
    "POST",
    "/queue/complete",
    { queueKey },
  );
  return result.success;
}

/**
 * Release a claimed job without completing it.
 * This deletes all claims for the job but leaves the job in the queue.
 * Used when a worker claims a job but can't process it (e.g., crawl concurrency limit).
 *
 * @param jobId The job ID to release claims for
 */
async function releaseJob(jobId: string): Promise<void> {
  await httpRequest<{ success: boolean }>("POST", "/queue/release", { jobId });
}

export async function getTeamQueueCount(teamId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/queue/count/team/${encodeURIComponent(teamId)}`,
  );
  return result.count;
}

export async function getCrawlQueueCount(crawlId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/queue/count/crawl/${encodeURIComponent(crawlId)}`,
  );
  return result.count;
}

export async function getTeamQueuedJobIds(
  teamId: string,
  limit: number = 10000,
): Promise<Set<string>> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/queue/jobs/team/${encodeURIComponent(teamId)}?limit=${limit}`,
  );
  return new Set(result.jobIds);
}

// === Active Job Tracking ===

export async function pushActiveJob(
  teamId: string,
  jobId: string,
  timeout: number,
): Promise<void> {
  await httpRequest("POST", "/active/push", {
    teamId,
    jobId,
    timeout,
  });
}

export async function removeActiveJob(
  teamId: string,
  jobId: string,
): Promise<void> {
  await httpRequest("DELETE", "/active/remove", {
    teamId,
    jobId,
  });
}

export async function getActiveJobCount(teamId: string): Promise<number> {
  const result = await httpRequest<{ count: number }>(
    "GET",
    `/active/count/${encodeURIComponent(teamId)}`,
  );
  return result.count;
}

export async function getActiveJobs(teamId: string): Promise<string[]> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/active/jobs/${encodeURIComponent(teamId)}`,
  );
  return result.jobIds;
}

// === Crawl Active Job Tracking ===

export async function pushCrawlActiveJob(
  crawlId: string,
  jobId: string,
  timeout: number,
): Promise<void> {
  await httpRequest("POST", "/active/crawl/push", {
    crawlId,
    jobId,
    timeout,
  });
}

export async function removeCrawlActiveJob(
  crawlId: string,
  jobId: string,
): Promise<void> {
  await httpRequest("DELETE", "/active/crawl/remove", {
    crawlId,
    jobId,
  });
}

export async function getCrawlActiveJobs(crawlId: string): Promise<string[]> {
  const result = await httpRequest<{ jobIds: string[] }>(
    "GET",
    `/active/crawl/jobs/${encodeURIComponent(crawlId)}`,
  );
  return result.jobIds;
}

// === Cleanup Operations ===

export async function cleanExpiredJobs(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/expired-jobs",
  );
  return result.cleaned;
}

export async function cleanExpiredActiveJobs(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/expired-active-jobs",
  );
  return result.cleaned;
}

export async function cleanStaleCounters(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/stale-counters",
  );
  return result.cleaned;
}

export async function cleanOrphanedClaims(): Promise<number> {
  const result = await httpRequest<{ cleaned: number }>(
    "POST",
    "/cleanup/orphaned-claims",
  );
  return result.cleaned;
}

// === Counter Reconciliation ===

export async function reconcileTeamQueueCounter(
  teamId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/team/queue/${encodeURIComponent(teamId)}`,
  );
  return result.correction;
}

export async function reconcileTeamActiveCounter(
  teamId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/team/active/${encodeURIComponent(teamId)}`,
  );
  return result.correction;
}

export async function reconcileCrawlQueueCounter(
  crawlId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/crawl/queue/${encodeURIComponent(crawlId)}`,
  );
  return result.correction;
}

export async function reconcileCrawlActiveCounter(
  crawlId: string,
): Promise<number> {
  const result = await httpRequest<{ correction: number }>(
    "POST",
    `/reconcile/crawl/active/${encodeURIComponent(crawlId)}`,
  );
  return result.correction;
}

// === Counter Sampling ===

export async function sampleTeamCounters(
  limit: number,
  afterTeamId?: string,
): Promise<string[]> {
  let url = `/sample/teams?limit=${limit}`;
  if (afterTeamId) {
    url += `&after=${encodeURIComponent(afterTeamId)}`;
  }
  const result = await httpRequest<{ ids: string[] }>("GET", url);
  return result.ids;
}

export async function sampleCrawlCounters(
  limit: number,
  afterCrawlId?: string,
): Promise<string[]> {
  let url = `/sample/crawls?limit=${limit}`;
  if (afterCrawlId) {
    url += `&after=${encodeURIComponent(afterCrawlId)}`;
  }
  const result = await httpRequest<{ ids: string[] }>("GET", url);
  return result.ids;
}

// === Configuration ===

export function isFDBConfigured(): boolean {
  return !!config.FDB_QUEUE_SERVICE_URL;
}

export function initFDB(): boolean {
  if (!config.FDB_QUEUE_SERVICE_URL) {
    logger.info("FDB Queue Service not configured, skipping initialization");
    return false;
  }
  logger.info("FDB Queue Service client initialized", {
    serviceUrl: config.FDB_QUEUE_SERVICE_URL,
  });
  return true;
}
