import { v7 as uuidv7 } from "uuid";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { logRequest } from "../logging/log_job";
import { getMonitorDiffArtifact } from "../../lib/gcs-monitoring";
import { processJobInternal } from "../worker/scrape-worker";
import {
  NuQJob,
  crawlGroup,
  scrapeQueue,
  resolveNewGroupBackend,
} from "../worker/nuq-router";
import { ScrapeJobData } from "../../types";
import { includesFormat } from "../../lib/format-utils";
import { normalizeMonitorFormats } from "./diff";
import { autumnService } from "../autumn/autumn.service";
import { getBillingQueue } from "../queue-service";
import {
  crawlToCrawler,
  markCrawlActive,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ, addScrapeJob } from "../queue-jobs";
import {
  CrawlRequest,
  type ScrapeOptions,
  crawlRequestSchema,
  scrapeRequestSchema,
  toV0CrawlerOptions,
} from "../../controllers/v2/types";
import { createWebhookSender, WebhookEvent } from "../webhook";
import { sendMonitorPageWebhook } from "./results";
import { sendMonitoringEmailSummary } from "../notification/monitoring_email";
import { sendMonitoringSlackSummary } from "../notification/monitoring_slack";
import {
  bulkUpsertMonitorPages,
  calculateMonitorCheckActualCredits,
  getMonitorCheck,
  getMonitorForUpdate,
  countMonitorCheckPages,
  insertMonitorCheckPages,
  deleteMonitorCheckPages,
  listActiveMonitorPages,
  listMonitorCheckPages,
  listRunningMonitorChecks,
  markMonitorRunning,
  updateMonitorCheck,
  updateMonitorCheckIfRunning,
  updateMonitorScheduleAfterRun,
  upsertMonitorPage,
} from "./store";
import type {
  MonitorCheckPageInsert,
  MonitorCheckRow,
  MonitorRow,
  MonitorTarget,
} from "./types";
import { withMarkdownFormat } from "./types";
import { redisEvictConnection } from "../redis";
import type { MonitorCheckJobData } from "./queue";
import {
  MONITOR_CHECK_STALE_ERROR,
  isMonitorCheckStale,
  MONITOR_CHECK_STALE_TIMEOUT_MS,
  monitorCheckStaleTimeoutMs,
} from "./stale";
import { trackMonitorCheckStartedInterest } from "./interest";
import { runSearchTarget, type ScrapeSearchResult } from "./search/run";
import { verdictJsonSchema } from "./search/judge";
import { computeGoalVersion } from "./search/dedupe";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { getACUCTeam } from "../../controllers/auth";
import {
  reconstructKnownState,
  searchStatusToPageStatus,
} from "./search/persist";

const logger = _logger.child({ module: "monitoring-runner" });
export { isMonitorCheckStale, MONITOR_CHECK_STALE_TIMEOUT_MS };

const MONITOR_NOTIFY_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
const MONITOR_CHECK_PAGE_SCAN_LIMIT = 100_000;
const MONITOR_CHECK_NO_CREDITS_ERROR =
  "Monitor check skipped: insufficient credits.";
const TERMINAL_CHECK_STATUSES = new Set([
  "completed",
  "partial",
  "failed",
  "skipped_overlap",
  "skipped_no_credits",
]);

async function claimMonitorNotification(checkId: string): Promise<boolean> {
  const result = await redisEvictConnection.set(
    `monitor-check-notify:${checkId}`,
    "1",
    "EX",
    MONITOR_NOTIFY_CLAIM_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}

type PageResult = MonitorCheckPageInsert & {
  emailStatus?: string;
};

type MonitorTargetRun =
  | {
      targetId: string;
      type: "scrape";
      expectedJobs: string[];
    }
  | {
      targetId: string;
      type: "crawl";
      crawlId: string;
    }
  | {
      targetId: string;
      type: "search";
      // Set only after the inline search stamps credits; reconciler waits on this so it never finalizes with credits at 0.
      searchCompleted?: boolean;
      resultCount?: number;
      matches?: number;
      summary?: string;
      judgeDegraded?: boolean;
      degradedReason?: string | null;
      searchCredits?: number;
      judgeCredits?: number;
      resultsJudged?: number;
    };

function createMonitorTargetRun(target: MonitorTarget): MonitorTargetRun {
  if (target.type === "scrape") {
    return {
      targetId: target.id,
      type: "scrape",
      expectedJobs: target.urls.map(() => uuidv7()),
    };
  }

  if (target.type === "search") {
    return {
      targetId: target.id,
      type: "search",
    };
  }

  return {
    targetId: target.id,
    type: "crawl",
    crawlId: uuidv7(),
  };
}

async function recoverTargetRunsFromRecordedPages(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
}): Promise<MonitorTargetRun[]> {
  const scrapeRuns: MonitorTargetRun[] = params.monitor.targets
    .filter((target): target is Extract<MonitorTarget, { type: "scrape" }> => {
      return target.type === "scrape";
    })
    .map(target => ({
      targetId: target.id,
      type: "scrape" as const,
      expectedJobs: target.urls.map(
        (_, index) => `recovered:${target.id}:${index}`,
      ),
    }));
  const crawlTargets = params.monitor.targets.filter(
    target => target.type === "crawl",
  );
  if (crawlTargets.length === 0) return scrapeRuns;

  const pages = await listMonitorCheckPages({
    teamId: params.monitor.team_id,
    monitorId: params.monitor.id,
    checkId: params.check.id,
    limit: MONITOR_CHECK_PAGE_SCAN_LIMIT,
    skip: 0,
  });
  const recovered = [...scrapeRuns];

  for (const target of crawlTargets) {
    const page = pages.find(
      candidate =>
        candidate.target_id === target.id &&
        typeof candidate.current_scrape_id === "string",
    );
    if (!page?.current_scrape_id) continue;

    const scrapeJob = await scrapeQueue
      .getJob(page.current_scrape_id, logger)
      .catch(error => {
        logger.warn(
          "Failed to recover monitor crawl target run from page job",
          {
            error,
            monitorId: params.monitor.id,
            checkId: params.check.id,
            targetId: target.id,
            scrapeId: page.current_scrape_id,
          },
        );
        return null;
      });
    const crawlId =
      scrapeJob?.data?.mode === "single_urls"
        ? (scrapeJob.data.crawl_id ?? scrapeJob.groupId)
        : scrapeJob?.groupId;
    if (!crawlId) continue;

    recovered.push({
      targetId: target.id,
      type: "crawl",
      crawlId,
    });
  }

  const recoveredTargetIds = new Set(recovered.map(target => target.targetId));
  if (
    !params.monitor.targets.every(target => recoveredTargetIds.has(target.id))
  ) {
    return [];
  }

  return recovered;
}

function withMonitorScrapeDefaults(
  options: Record<string, unknown>,
): ScrapeOptions {
  const formats = Array.isArray(options.formats)
    ? normalizeMonitorFormats(options.formats)
    : options.formats;
  return {
    maxAge: 0,
    ...withMarkdownFormat({ ...options, formats }),
  };
}

export function estimateActualCredits(doc: any, options?: any): number {
  // Prefer the credits the scrape path actually recorded when present.
  const creditsUsed = doc?.metadata?.creditsUsed;
  if (typeof creditsUsed === "number" && Number.isFinite(creditsUsed)) {
    return creditsUsed;
  }
  const formats = Array.isArray(options?.formats) ? options.formats : [];
  // Only charge the JSON-extraction premium when extraction produced a json; a
  // failed extraction still scraped the page, so fall back to base credit.
  // Deterministic JSON costs 7 (reusable extractor); plain JSON 5.
  const producedJson = doc?.json != null;
  if (!producedJson) return 1;
  if (includesFormat(formats, "deterministicJson")) return 7;
  if (includesFormat(formats, "json")) return 5;
  return 1;
}

// Deep-mode search-monitor page scrape, inline (skipNuq) so it bypasses scrape
// concurrency; caller bounds fan-out via SEARCH_SCRAPE_CONCURRENCY. Never billed
// per-page — search monitors bill flat at the check level.
async function scrapeSearchMonitorPage(params: {
  teamId: string;
  checkId: string;
  url: string;
  judgePrompt: string;
}): Promise<ScrapeSearchResult | null> {
  const scrapeId = uuidv7();
  const scrapeOptions = scrapeRequestSchema.parse({
    url: params.url,
    formats: [
      { type: "markdown" },
      { type: "json", schema: verdictJsonSchema, prompt: params.judgePrompt },
    ],
    timeout: 20000,
    origin: "monitor",
  });

  await logRequest({
    id: scrapeId,
    kind: "scrape",
    api_version: "v2",
    team_id: params.teamId,
    origin: "monitor",
    integration: null,
    target_hint: params.url,
    zeroDataRetention: false,
    api_key_id: null,
  });

  const job: NuQJob<ScrapeJobData> = {
    id: scrapeId,
    status: "active",
    createdAt: new Date(),
    priority: 20,
    data: {
      mode: "single_urls",
      url: params.url,
      team_id: params.teamId,
      scrapeOptions,
      internalOptions: {
        teamId: params.teamId,
        saveScrapeResultToGCS: !!config.GCS_FIRE_ENGINE_BUCKET_NAME,
        bypassBilling: true,
        zeroDataRetention: false,
      },
      skipNuq: true,
      origin: "monitor",
      integration: null,
      billing: { endpoint: "monitor", jobId: params.checkId },
      zeroDataRetention: false,
      apiKeyId: null,
    },
  };

  const doc = await processJobInternal(job);
  if (!doc) return null;
  return {
    json: doc.json ?? null,
    markdown: doc.markdown ?? "",
    metadata: {
      publishedTime: doc.metadata?.publishedTime ?? null,
      modifiedTime: doc.metadata?.modifiedTime ?? null,
    },
  };
}

function summarize(pages: PageResult[]) {
  return {
    totalPages: pages.length,
    same: pages.filter(page => page.status === "same").length,
    changed: pages.filter(page => page.status === "changed").length,
    new: pages.filter(page => page.status === "new").length,
    removed: pages.filter(page => page.status === "removed").length,
    error: pages.filter(page => page.status === "error").length,
  };
}

async function billMonitorCheck(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  actualCredits: number;
  lockId: string | null;
}): Promise<void> {
  if (params.lockId) {
    await autumnService.finalizeCreditsLock({
      lockId: params.lockId,
      action: "confirm",
      overrideValue: params.actualCredits,
      properties: {
        source: "monitorCheck",
        endpoint: "monitor",
        jobId: params.check.id,
      },
    });
  }

  if (params.actualCredits <= 0 || !config.USE_DB_AUTHENTICATION) return;

  await getBillingQueue().add(
    "bill_team",
    {
      team_id: params.monitor.team_id,
      credits: params.actualCredits,
      billing: { endpoint: "monitor", jobId: params.check.id },
      is_extract: false,
      timestamp: new Date().toISOString(),
      originating_job_id: params.check.id,
      api_key_id: null,
      autumnTrackInRequest: Boolean(params.lockId),
    },
    {
      // Deterministic per check so a re-finalize (e.g. the reconciler re-running this
      // check after the finalize lock TTL expired mid-finalize) re-enqueues the SAME
      // job id and the billing queue dedups it instead of charging the team twice.
      jobId: `monitor-bill-${params.check.id}`,
      priority: 10,
    },
  );
}

async function sendNotifications(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: PageResult[];
}): Promise<{ webhook?: unknown; email?: unknown; slack?: unknown }> {
  const payload = {
    monitorId: params.monitor.id,
    checkId: params.check.id,
    status: params.check.status,
    summary: toSummaryObject(params.check),
  };

  let webhookStatus: unknown = { attempted: false };
  if (params.monitor.webhook) {
    const sender = await createWebhookSender({
      teamId: params.monitor.team_id,
      jobId: params.check.id,
      webhook: params.monitor.webhook as any,
      v0: false,
    });
    try {
      const result = await sender?.send(WebhookEvent.MONITOR_CHECK_COMPLETED, {
        success: params.check.status === "completed",
        data: [payload],
        error: params.check.error ?? undefined,
        awaitWebhook: true,
      });
      webhookStatus = {
        attempted: result?.attempted ?? false,
        success: result?.delivered === true,
        delivered: result?.delivered === true,
        queued: result?.queued === true,
        skipped: result?.skipped === true,
      };
    } catch (error) {
      webhookStatus = {
        attempted: true,
        success: false,
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const nonSamePages = params.pages.filter(page => page.status !== "same");
  // Pull diff text for up to 5 meaningful changed pages so the email leads with
  // the diff. Errors swallowed per-page so one GCS hiccup doesn't drop the alert.
  const diffEligible = nonSamePages
    .filter(
      p => p.status === "changed" && (!p.judgment || p.judgment.meaningful),
    )
    .slice(0, 5);
  const diffTextByUrl = new Map<string, string>();
  await Promise.all(
    diffEligible.map(async page => {
      if (!page.diff_gcs_key) return;
      try {
        const artifact = await getMonitorDiffArtifact(page.diff_gcs_key);
        const text =
          artifact?.kind === "markdown"
            ? artifact.text
            : artifact?.markdown?.text;
        if (text) diffTextByUrl.set(page.url, text);
      } catch (error) {
        logger.warn("Failed to load diff artifact for email", {
          error,
          url: page.url,
        });
      }
    }),
  );

  const emailStatus = await sendMonitoringEmailSummary({
    monitor: params.monitor,
    check: params.check,
    pages: nonSamePages.map(page => ({
      url: page.url,
      status: page.status,
      error: page.error,
      judgment: page.judgment ?? null,
      diffText: diffTextByUrl.get(page.url) ?? null,
    })),
  });

  let slackStatus: unknown = { attempted: false };
  try {
    slackStatus = await sendMonitoringSlackSummary({
      monitor: params.monitor,
      check: params.check,
      pages: nonSamePages.map(page => ({
        url: page.url,
        status: page.status,
        judgment: page.judgment ?? null,
      })),
    });
  } catch (error) {
    logger.warn("Slack monitor summary threw", {
      error,
      monitorId: params.monitor.id,
      checkId: params.check.id,
    });
    slackStatus = {
      attempted: true,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    webhook: webhookStatus,
    email: emailStatus,
    slack: slackStatus,
  };
}

async function enqueueMonitorScrapeTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
  targetRun: Extract<MonitorTargetRun, { type: "scrape" }>;
}): Promise<Extract<MonitorTargetRun, { type: "scrape" }>> {
  if (params.target.type !== "scrape") {
    throw new Error("Expected scrape target");
  }

  for (const [index, url] of params.target.urls.entries()) {
    const scrapeId = params.targetRun.expectedJobs[index];
    const scrapeOptions = scrapeRequestSchema.parse({
      url,
      ...withMonitorScrapeDefaults(params.target.scrapeOptions ?? {}),
      origin: "monitor",
    });

    await logRequest({
      id: scrapeId,
      kind: "scrape",
      api_version: "v2",
      team_id: params.monitor.team_id,
      origin: "monitor",
      integration: null,
      target_hint: url,
      zeroDataRetention: false,
      api_key_id: null,
    });

    await addScrapeJob(
      {
        mode: "single_urls",
        url,
        team_id: params.monitor.team_id,
        scrapeOptions,
        internalOptions: {
          teamId: params.monitor.team_id,
          saveScrapeResultToGCS: !!config.GCS_FIRE_ENGINE_BUCKET_NAME,
          bypassBilling: true,
          zeroDataRetention: false,
        },
        origin: "monitor",
        integration: null,
        billing: { endpoint: "monitor", jobId: params.check.id },
        zeroDataRetention: false,
        apiKeyId: null,
        monitoring: {
          monitorId: params.monitor.id,
          checkId: params.check.id,
          targetId: params.target.id,
          source: "explicit",
        },
      },
      scrapeId,
      20,
    );
  }

  return params.targetRun;
}

async function enqueueMonitorCrawlTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
  targetRun: Extract<MonitorTargetRun, { type: "crawl" }>;
}): Promise<Extract<MonitorTargetRun, { type: "crawl" }>> {
  if (params.target.type !== "crawl") {
    throw new Error("Expected crawl target");
  }

  const crawlId = params.targetRun.crawlId;
  const body = crawlRequestSchema.parse({
    url: params.target.url,
    ...(params.target.crawlOptions ?? {}),
    scrapeOptions: withMonitorScrapeDefaults(params.target.scrapeOptions ?? {}),
    origin: "monitor",
  }) as CrawlRequest;

  await logRequest({
    id: crawlId,
    kind: "crawl",
    api_version: "v2",
    team_id: params.monitor.team_id,
    origin: "monitor",
    integration: null,
    target_hint: body.url,
    zeroDataRetention: false,
    api_key_id: null,
  });

  const crawlerOptions = {
    ...body,
    url: undefined,
    scrapeOptions: undefined,
    prompt: undefined,
  };

  const sc: StoredCrawl = {
    originUrl: body.url,
    crawlerOptions: toV0CrawlerOptions(crawlerOptions),
    scrapeOptions: body.scrapeOptions,
    internalOptions: {
      disableSmartWaitCache: true,
      teamId: params.monitor.team_id,
      saveScrapeResultToGCS: !!config.GCS_FIRE_ENGINE_BUCKET_NAME,
      zeroDataRetention: false,
      bypassBilling: true,
    },
    team_id: params.monitor.team_id,
    createdAt: Date.now(),
    maxConcurrency: body.maxConcurrency,
    zeroDataRetention: false,
  };

  const crawler = crawlToCrawler(crawlId, sc, null);
  try {
    sc.robots = await crawler.getRobotsTxt(
      body.scrapeOptions.skipTlsVerification,
    );
  } catch {
    // Non-fatal robots fetch failure, same as the public crawl controller.
  }

  sc.queueBackend = await resolveNewGroupBackend(sc.team_id);
  await crawlGroup.addGroup(crawlId, sc.team_id, 24 * 60 * 60 * 1000, {
    backend: sc.queueBackend,
    maxConcurrency: sc.maxConcurrency,
    delaySeconds: sc.crawlerOptions?.delay,
  });
  await saveCrawl(crawlId, sc);
  await markCrawlActive(crawlId);

  await _addScrapeJobToBullMQ(
    {
      url: body.url,
      mode: "kickoff",
      team_id: params.monitor.team_id,
      crawlerOptions,
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: "monitor",
      integration: null,
      billing: { endpoint: "monitor", jobId: params.check.id },
      crawl_id: crawlId,
      v1: true,
      zeroDataRetention: false,
      apiKeyId: null,
      monitoring: {
        monitorId: params.monitor.id,
        checkId: params.check.id,
        targetId: params.target.id,
        source: "discovered",
      },
    },
    uuidv7(),
  );

  return params.targetRun;
}

// Runs inline, persisting onto the same monitor_pages / monitor_check_pages
// tables the reconciler tallies.
// Bound the inline finalize writes: under write-pool exhaustion they can wait forever,
// stranding the check until the 10-min reaper. Throw so the catch fails it fast instead.
const MONITOR_FINALIZE_WRITE_TIMEOUT_MS = 60_000;

class MonitorFinalizeTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} exceeded ${ms}ms`);
    this.name = "MonitorFinalizeTimeoutError";
  }
}

// Reject (not resolve) on timeout so a stalled write fails fast into the catch path.
// The race rejects but can't truly cancel work(); we abort a signal so work() can
// cooperatively stop issuing further writes, otherwise a stalled write may land
// AFTER the catch has marked the check terminal — corrupting cross-run dedup state.
export async function withFinalizeTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  what: string,
  ms: number = MONITOR_FINALIZE_WRITE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MonitorFinalizeTimeoutError(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runMonitorSearchTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
}): Promise<{
  pages: PageResult[];
  resultCount: number;
  matches: number;
  summary: string;
  judgeDegraded: boolean;
  degradedReason: string | null;
  // Flat credits, recorded onto target_results by the caller.
  searchCredits: number;
  judgeCredits: number;
  resultsJudged: number;
}> {
  if (params.target.type !== "search") {
    return {
      pages: [],
      resultCount: 0,
      matches: 0,
      summary: "",
      judgeDegraded: false,
      degradedReason: null,
      searchCredits: 0,
      judgeCredits: 0,
      resultsJudged: 0,
    };
  }
  const { monitor, check, target } = params;
  const goalVersion = computeGoalVersion(
    monitor.goal,
    monitor.name,
    target.queries,
  );

  // Rebuild per-URL dedup memory + event index from this target's prior pages.
  const priorPages = await listActiveMonitorPages({
    monitorId: monitor.id,
    targetId: target.id,
  });
  const { knownPages, knownEvents } = reconstructKnownState(
    priorPages,
    goalVersion,
  );

  // Same blocklist gate prod scrapes use, applied per team (honors unblockedDomains).
  const acuc = await getACUCTeam(monitor.team_id);
  const teamFlags = acuc?.flags ?? null;

  const result = await runSearchTarget({
    monitor: {
      id: monitor.id,
      teamId: monitor.team_id,
      goal: monitor.goal,
      subject: monitor.name,
      // Read fresh each check so a PATCH/UI toggle takes effect next check.
      judgeEnabled: Boolean(monitor.judge_enabled),
    },
    target: {
      id: target.id,
      queries: target.queries,
      searchWindow: target.searchWindow,
      // depth/alertMode aren't API-settable but stored targets may carry them (back-compat); pass through.
      alertMode: target.alertMode ?? "first_match",
      includeDomains: target.includeDomains,
      excludeDomains: target.excludeDomains,
      recheckAfter: target.recheckAfter,
      maxResults: target.maxResults,
      depth: target.depth,
    },
    monitorCheckId: check.id,
    scrapePage: ({ url, judgePrompt }) =>
      scrapeSearchMonitorPage({
        teamId: monitor.team_id,
        checkId: check.id,
        url,
        judgePrompt,
      }),
    isBlocked: url =>
      isUrlBlocked(url, teamFlags, {
        team_id: monitor.team_id,
        origin: "monitor.search",
      }),
    goalVersion,
    knownPages,
    knownEvents,
    zeroDataRetention: false,
    logger: logger.child({
      monitorId: monitor.id,
      checkId: check.id,
      targetId: target.id,
    }),
  });

  const searchCredits = result.searchCredits;
  const judgeCredits = result.judgeCredits;

  // Search pages carry no per-page credit — billed once at check level.
  const pages: PageResult[] = result.pageUpserts.map(upsert => {
    const status = searchStatusToPageStatus(upsert.status);
    return {
      check_id: check.id,
      monitor_id: monitor.id,
      team_id: monitor.team_id,
      target_id: target.id,
      url: upsert.url,
      url_hash: upsert.urlHash,
      status,
      metadata: upsert.metadata,
      judgment: upsert.judgment ?? null,
      emailStatus: status,
    };
  });

  await withFinalizeTimeout(async signal => {
    // Per-check rows first: idempotent (delete+insert replace) and not read across runs.
    // Clear rows from a prior (crashed/redelivered) run so the insert is a replace, not a duplicate.
    if (signal.aborted) return;
    await deleteMonitorCheckPages({ checkId: check.id, targetId: target.id });
    if (signal.aborted) return;
    await insertMonitorCheckPages(pages);

    // Durable cross-run dedup baseline last, so a timeout before this point leaves
    // monitor_pages untouched and the next run re-alerts. One bulk upsert (~3 round-
    // trips) instead of ~2N sequential pool acquisitions that stalled finalization;
    // the signal lets an aborted finalize skip the write entirely.
    await bulkUpsertMonitorPages({
      monitorId: monitor.id,
      teamId: monitor.team_id,
      targetId: target.id,
      checkId: check.id,
      rows: pages.map(page => ({
        url: page.url,
        urlHash: page.url_hash,
        status: page.status,
        metadata: page.metadata as Record<string, unknown>,
        source: "discovered",
        scrapeId: null,
      })),
      abortSignal: signal,
    });
  }, "monitor search page-write tail");

  for (const page of pages) {
    if (page.status !== "new" && page.status !== "error") continue;
    await sendMonitorPageWebhook({
      teamId: monitor.team_id,
      monitorId: monitor.id,
      checkId: check.id,
      url: page.url,
      status: page.status,
      error: page.error ?? null,
      judgment: page.judgment ?? null,
    });
  }

  return {
    pages,
    resultCount: result.resultCount,
    matches: result.matches,
    summary: result.summary,
    judgeDegraded: result.judgeDegraded,
    degradedReason: result.degradedReason,
    searchCredits,
    judgeCredits,
    resultsJudged: result.resultsJudged,
  };
}

// Find a completed search target run so a redelivered check can restore its
// figures instead of re-running (and re-billing) it.
export function findCompletedSearchTargetRun(
  targetResults: unknown,
  targetId: string,
): Record<string, unknown> | null {
  if (!Array.isArray(targetResults)) return null;
  const match = targetResults.find(
    tr =>
      tr != null &&
      typeof tr === "object" &&
      (tr as { type?: unknown }).type === "search" &&
      (tr as { targetId?: unknown }).targetId === targetId &&
      (tr as { searchCompleted?: unknown }).searchCompleted === true,
  );
  return (match as Record<string, unknown>) ?? null;
}

export async function processMonitorCheckJob(
  job: MonitorCheckJobData,
): Promise<void> {
  const monitor = await getMonitorForUpdate(job.teamId, job.monitorId);
  if (!monitor) {
    throw new Error("Monitor not found");
  }

  const initialCheck = await getMonitorCheck(
    job.teamId,
    job.monitorId,
    job.checkId,
  );
  if (!initialCheck) {
    throw new Error("Monitor check not found");
  }
  if (TERMINAL_CHECK_STATUSES.has(initialCheck.status)) {
    return;
  }

  await markMonitorRunning({
    monitorId: monitor.id,
    checkId: job.checkId,
  });

  let check: MonitorCheckRow = await updateMonitorCheck(job.checkId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  trackMonitorCheckStartedInterest({ monitor, check }).catch(error =>
    logger.warn("Failed to track monitor target interest", {
      error,
      monitorId: monitor.id,
      checkId: check.id,
      eventType: "check_started",
    }),
  );

  let lockId: string | null = null;
  try {
    const lock = await autumnService.lockCredits({
      teamId: monitor.team_id,
      value: check.estimated_credits ?? 1,
      lockId: `monitor_${check.id}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
      properties: {
        source: "monitorCheck",
        endpoint: "monitor",
        jobId: check.id,
      },
    });

    if (lock.status === "denied") {
      check = await updateMonitorCheck(check.id, {
        status: "skipped_no_credits",
        finished_at: new Date().toISOString(),
        actual_credits: 0,
        billing_status: "not_applicable",
        error: MONITOR_CHECK_NO_CREDITS_ERROR,
      });

      await updateMonitorScheduleAfterRun({ monitor, check });

      logger.info("Skipped monitor check: insufficient credits", {
        monitorId: monitor.id,
        checkId: check.id,
        teamId: monitor.team_id,
      });
      return;
    }

    lockId = lock.status === "locked" ? lock.lockId : null;

    check = await updateMonitorCheck(check.id, {
      autumn_lock_id: lockId,
      reserved_credits: lockId ? (check.estimated_credits ?? 1) : null,
      billing_status: lockId ? "reserved" : "not_applicable",
    });

    const targetResults = monitor.targets.map(createMonitorTargetRun);
    await updateMonitorCheck(check.id, {
      target_results: targetResults,
    });

    for (const [index, target] of monitor.targets.entries()) {
      const targetRun = targetResults[index];
      if (target.type === "scrape" && targetRun.type === "scrape") {
        await enqueueMonitorScrapeTarget({ monitor, check, target, targetRun });
      } else if (target.type === "crawl" && targetRun.type === "crawl") {
        await enqueueMonitorCrawlTarget({ monitor, check, target, targetRun });
      } else if (target.type === "search" && targetRun.type === "search") {
        // Redelivery after inline work finished but before ack: restore persisted
        // figures instead of re-running, which would re-bill and re-scrape.
        const priorRun = findCompletedSearchTargetRun(
          initialCheck.target_results,
          target.id,
        );
        if (priorRun) {
          Object.assign(targetRun, priorRun);
          targetRun.searchCompleted = true;
          continue;
        }
        // Search runs synchronously; fold its outcome into target_results.
        const searchResult = await runMonitorSearchTarget({
          monitor,
          check,
          target,
        });
        targetRun.resultCount = searchResult.resultCount;
        targetRun.matches = searchResult.matches;
        targetRun.summary = searchResult.summary;
        targetRun.judgeDegraded = searchResult.judgeDegraded;
        targetRun.degradedReason = searchResult.degradedReason;
        targetRun.searchCredits = searchResult.searchCredits;
        targetRun.judgeCredits = searchResult.judgeCredits;
        targetRun.resultsJudged = searchResult.resultsJudged;
        // Set last, after credits are stamped, so the reconciler never finalizes with credits at 0.
        targetRun.searchCompleted = true;
        // Persist searchCompleted now so a crash/redelivery short-circuits via
        // findCompletedSearchTargetRun instead of re-running and re-billing.
        await withFinalizeTimeout(
          signal =>
            signal.aborted
              ? Promise.resolve(null)
              : // Atomic guard: if this write outran the timeout and the catch
                // already failed the check, no-op instead of stamping searchCompleted.
                updateMonitorCheckIfRunning(check.id, {
                  target_results: targetResults,
                }),
          "monitor search searchCompleted flush",
        );
      }
    }

    await updateMonitorCheck(check.id, {
      target_results: targetResults,
    });
  } catch (error) {
    // Atomically flip running -> failed. Returns null when the check already
    // reached a terminal status — i.e. the reconciler finalized it (completed,
    // billed, lock confirmed) before this late catch ran. In that case we must
    // not clobber its terminal state or release its now-confirmed credit lock;
    // the reconciler already owns billing, notifications, and scheduling.
    const failed = await updateMonitorCheckIfRunning(check.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      billing_status: lockId ? "released" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });

    if (!failed) {
      throw error;
    }
    check = failed;

    if (lockId) {
      await autumnService.finalizeCreditsLock({
        lockId,
        action: "release",
        properties: {
          source: "monitorCheck",
          endpoint: "monitor",
          jobId: check.id,
        },
      });
    }

    if (
      await claimMonitorNotification(check.id).catch(error => {
        logger.warn(
          "Failed to claim monitor notification; continuing without dedupe",
          {
            error,
            monitorId: monitor.id,
            checkId: check.id,
          },
        );
        return true;
      })
    ) {
      const notificationStatus = await sendNotifications({
        monitor,
        check,
        pages: [],
      }).catch(err => {
        logger.warn("Failed to send monitor failure notifications", {
          error: err,
        });
        return null;
      });
      if (notificationStatus) {
        check = await updateMonitorCheck(check.id, {
          notification_status: notificationStatus,
        }).catch(updateError => {
          logger.warn("Failed to record monitor failure notification status", {
            error: updateError,
            monitorId: monitor.id,
            checkId: check.id,
          });
          return check;
        });
      }
    }

    await updateMonitorScheduleAfterRun({
      monitor,
      check,
    });

    throw error;
  }
}

async function processRemovedPagesForCompletedCrawls(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  targetResults: any[];
}): Promise<void> {
  for (const target of params.targetResults) {
    if (target?.type !== "crawl" || target.removedProcessed) continue;

    const group = await crawlGroup.getGroup(target.crawlId);
    if (group?.status !== "completed") continue;

    const checkPages = await listMonitorCheckPages({
      teamId: params.monitor.team_id,
      monitorId: params.monitor.id,
      checkId: params.check.id,
      limit: MONITOR_CHECK_PAGE_SCAN_LIMIT,
      skip: 0,
    });
    const seen = new Set(
      checkPages
        .filter(page => page.target_id === target.targetId)
        .map(page => page.url_hash.toString("hex")),
    );
    const activePages = await listActiveMonitorPages({
      monitorId: params.monitor.id,
      targetId: target.targetId,
    });

    const removed: MonitorCheckPageInsert[] = [];
    for (const previous of activePages) {
      if (seen.has(previous.url_hash.toString("hex"))) continue;
      await upsertMonitorPage({
        monitorId: params.monitor.id,
        teamId: params.monitor.team_id,
        targetId: target.targetId,
        url: previous.url,
        source: previous.source,
        checkId: params.check.id,
        scrapeId: previous.last_scrape_id,
        status: "removed",
        metadata: previous.metadata,
      });
      removed.push({
        check_id: params.check.id,
        monitor_id: params.monitor.id,
        team_id: params.monitor.team_id,
        target_id: target.targetId,
        url: previous.url,
        url_hash: previous.url_hash,
        status: "removed" as const,
        previous_scrape_id: previous.last_scrape_id,
        current_scrape_id: null,
      });
    }

    await insertMonitorCheckPages(removed);
    target.removedProcessed = true;
  }
}

async function isMonitorCheckComplete(
  check: MonitorCheckRow,
  monitor?: MonitorRow,
): Promise<boolean> {
  let targetResults = Array.isArray(check.target_results)
    ? (check.target_results as any[])
    : [];

  if (targetResults.length === 0) {
    if (!monitor) return false;

    targetResults = await recoverTargetRunsFromRecordedPages({
      monitor,
      check,
    });
    if (targetResults.length === 0) return false;
  }

  for (const target of targetResults) {
    if (target?.type === "search") {
      // Not complete until the inline search has stamped its credits.
      if (!target.searchCompleted) return false;
    } else if (target?.type === "scrape") {
      const expected = Array.isArray(target.expectedJobs)
        ? target.expectedJobs.length
        : 0;
      const recorded = await countMonitorCheckPages({
        checkId: check.id,
        targetId: target.targetId,
      });
      if (recorded < expected) return false;
    } else if (target?.type === "crawl") {
      const group = await crawlGroup.getGroup(target.crawlId);
      if (!group || group.status === "active") return false;

      const stats = await scrapeQueue.getGroupNumericStats(
        target.crawlId,
        logger,
      );
      const unfinished =
        (stats.active ?? 0) + (stats.queued ?? 0) + (stats.backlog ?? 0);
      if (unfinished > 0) return false;
    }
  }

  return true;
}

async function failStaleMonitorCheck(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
}): Promise<boolean> {
  if (!isMonitorCheckStale(params.check, new Date(), params.monitor.targets))
    return false;

  const error = MONITOR_CHECK_STALE_ERROR;
  if (params.check.autumn_lock_id) {
    await autumnService
      .finalizeCreditsLock({
        lockId: params.check.autumn_lock_id,
        action: "release",
        properties: {
          source: "monitorCheck",
          endpoint: "monitor",
          jobId: params.check.id,
        },
      })
      .catch(releaseError => {
        logger.warn("Failed to release stale monitor check credit lock", {
          error: releaseError,
          monitorId: params.monitor.id,
          checkId: params.check.id,
          lockId: params.check.autumn_lock_id,
        });
      });
  }

  const finalized = await updateMonitorCheck(params.check.id, {
    status: "failed",
    finished_at: new Date().toISOString(),
    actual_credits: 0,
    billing_status: params.check.autumn_lock_id ? "released" : "not_applicable",
    error,
  });

  let withNotifications = finalized;
  if (await claimMonitorNotification(params.check.id)) {
    const notificationStatus = await sendNotifications({
      monitor: params.monitor,
      check: finalized,
      pages: [],
    }).catch(notificationError => {
      logger.warn("Failed to send stale monitor check notifications", {
        error: notificationError,
        monitorId: params.monitor.id,
        checkId: params.check.id,
      });
      return {
        webhook: {
          attempted: !!params.monitor.webhook,
          success: false,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        },
        email: {
          attempted: !!params.monitor.notification?.email?.enabled,
          success: false,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        },
      };
    });

    withNotifications = await updateMonitorCheck(params.check.id, {
      notification_status: notificationStatus,
    }).catch(updateError => {
      logger.warn("Failed to record stale monitor check notification status", {
        error: updateError,
        monitorId: params.monitor.id,
        checkId: params.check.id,
      });
      return finalized;
    });
  }

  if (params.monitor.current_check_id === params.check.id) {
    await updateMonitorScheduleAfterRun({
      monitor: params.monitor,
      check: withNotifications,
      summary: toSummaryObject(withNotifications),
    });
  }

  logger.warn("Failed stale monitor check", {
    monitorId: params.monitor.id,
    checkId: params.check.id,
    startedAt: params.check.started_at,
    timeoutMs: monitorCheckStaleTimeoutMs(params.check, params.monitor.targets),
  });

  return true;
}

export async function reconcileRunningMonitorChecks(
  limit: number = 50,
): Promise<void> {
  const checks = await listRunningMonitorChecks(limit);
  for (const check of checks) {
    const lockKey = `monitor-check-finalize:${check.id}`;
    const lock = await redisEvictConnection.set(lockKey, "1", "EX", 60, "NX");
    if (lock !== "OK") continue;

    try {
      const monitor = await getMonitorForUpdate(
        check.team_id,
        check.monitor_id,
      );
      if (!monitor) {
        if (check.autumn_lock_id) {
          await autumnService
            .finalizeCreditsLock({
              lockId: check.autumn_lock_id,
              action: "release",
              properties: {
                source: "monitorCheck",
                endpoint: "monitor",
                jobId: check.id,
              },
            })
            .catch(error => {
              logger.warn(
                "Failed to release orphaned monitor check credit lock",
                {
                  error,
                  monitorId: check.monitor_id,
                  checkId: check.id,
                  lockId: check.autumn_lock_id,
                },
              );
            });
        }

        await updateMonitorCheck(check.id, {
          status: "failed",
          finished_at: new Date().toISOString(),
          actual_credits: 0,
          billing_status: check.autumn_lock_id ? "released" : "not_applicable",
          error: "Monitor no longer exists.",
        });

        logger.warn("Failed orphaned monitor check", {
          monitorId: check.monitor_id,
          checkId: check.id,
        });
        continue;
      }

      if (await failStaleMonitorCheck({ monitor, check })) continue;

      // Snapshot from listRunningMonitorChecks; may be stale relative to the
      // inline handler that is still writing this check.
      let targetResults = Array.isArray(check.target_results)
        ? ([...check.target_results] as any[])
        : [];
      // True only when the persisted snapshot was empty and we rebuild the target
      // runs from recorded pages. That is the only case it is safe to write back
      // below: there is no live target_results to overwrite.
      const recoveredFromEmpty = targetResults.length === 0;
      if (recoveredFromEmpty) {
        targetResults = await recoverTargetRunsFromRecordedPages({
          monitor,
          check,
        });
      }

      await processRemovedPagesForCompletedCrawls({
        monitor,
        check,
        targetResults,
      });

      if (
        !(await isMonitorCheckComplete(
          {
            ...check,
            target_results: targetResults,
          },
          monitor,
        ))
      ) {
        // Only persist target_results we recovered from an empty snapshot. Writing
        // back a non-empty stale snapshot here can DOWNGRADE a searchCompleted=true
        // that the inline handler persisted after this reconciler loaded its
        // snapshot, reverting the marker and stranding the check until the stale
        // reaper. The complete-path write below is safe: a search target can only
        // be complete once its snapshot already carries searchCompleted=true.
        if (recoveredFromEmpty && targetResults.length > 0) {
          await updateMonitorCheck(check.id, { target_results: targetResults });
        }
        continue;
      }

      const [same, changed, newCount, removed, errorCount] = await Promise.all([
        countMonitorCheckPages({ checkId: check.id, status: "same" }),
        countMonitorCheckPages({ checkId: check.id, status: "changed" }),
        countMonitorCheckPages({ checkId: check.id, status: "new" }),
        countMonitorCheckPages({ checkId: check.id, status: "removed" }),
        countMonitorCheckPages({ checkId: check.id, status: "error" }),
      ]);
      const totalPages = same + changed + newCount + removed + errorCount;
      const actualCredits = await calculateMonitorCheckActualCredits({
        checkId: check.id,
        targets: monitor.targets,
        // Flat search credits come from target_results, not page metadata.
        targetResults,
      });

      let finalized = await updateMonitorCheck(check.id, {
        status: errorCount > 0 ? "partial" : "completed",
        finished_at: new Date().toISOString(),
        actual_credits: actualCredits,
        billing_status: check.autumn_lock_id ? "confirmed" : "not_applicable",
        total_pages: totalPages,
        same_count: same,
        changed_count: changed,
        new_count: newCount,
        removed_count: removed,
        error_count: errorCount,
        target_results: targetResults,
      });

      try {
        await billMonitorCheck({
          monitor,
          check: finalized,
          actualCredits,
          lockId: check.autumn_lock_id,
        });
      } catch (error) {
        logger.warn("Failed to bill monitor check during reconciliation", {
          monitorId: monitor.id,
          checkId: finalized.id,
          error,
        });
        finalized = await updateMonitorCheck(check.id, {
          billing_status: "failed",
        }).catch(updateError => {
          logger.warn("Failed to record monitor check billing failure", {
            monitorId: monitor.id,
            checkId: finalized.id,
            error: updateError,
          });
          return finalized;
        });
      }

      if (await claimMonitorNotification(check.id)) {
        let notificationStatus: {
          webhook?: unknown;
          email?: unknown;
          slack?: unknown;
        } | null = null;
        try {
          const pages = (await listMonitorCheckPages({
            teamId: monitor.team_id,
            monitorId: monitor.id,
            checkId: check.id,
            limit: 100,
            skip: 0,
          })) as PageResult[];

          notificationStatus = await sendNotifications({
            monitor,
            check: finalized,
            pages,
          });

          finalized = await updateMonitorCheck(check.id, {
            notification_status: notificationStatus,
            webhook_payload: notificationStatus.webhook
              ? { summary: toSummaryObject(finalized) }
              : null,
            email_payload: notificationStatus.email
              ? { summary: toSummaryObject(finalized) }
              : null,
          });
        } catch (error) {
          logger.warn("Failed to send monitor check notifications", {
            monitorId: monitor.id,
            checkId: finalized.id,
            error,
          });
          notificationStatus = {
            webhook: {
              attempted: !!monitor.webhook,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            email: {
              attempted: !!monitor.notification?.email?.enabled,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
          finalized = await updateMonitorCheck(check.id, {
            notification_status: notificationStatus,
          }).catch(updateError => {
            logger.warn("Failed to record monitor check notification failure", {
              monitorId: monitor.id,
              checkId: finalized.id,
              error: updateError,
            });
            return finalized;
          });
        }
      }

      await updateMonitorScheduleAfterRun({
        monitor,
        check: finalized,
        summary: toSummaryObject(finalized),
      });

      logger.info("Reconciled monitor check", {
        monitorId: monitor.id,
        checkId: finalized.id,
        status: finalized.status,
        totalPages,
        same,
        changed,
        new: newCount,
        removed,
        errors: errorCount,
      });
    } catch (error) {
      logger.warn("Failed to reconcile monitor check", {
        error,
        checkId: check.id,
      });
    } finally {
      await redisEvictConnection.del(lockKey);
    }
  }
}

function toSummaryObject(check: MonitorCheckRow) {
  return {
    totalPages: check.total_pages,
    same: check.same_count,
    changed: check.changed_count,
    new: check.new_count,
    removed: check.removed_count,
    error: check.error_count,
  };
}
