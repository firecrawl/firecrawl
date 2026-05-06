import { v7 as uuidv7 } from "uuid";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { logRequest } from "../logging/log_job";
import { processJobInternal } from "../worker/scrape-worker";
import { NuQJob, crawlGroup, scrapeQueue } from "../worker/nuq";
import { ScrapeJobData } from "../../types";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  monitorDiffGcsKey,
  saveMonitorDiffArtifact,
} from "../../lib/gcs-monitoring";
import { diffMonitorMarkdown } from "./diff";
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
import { sendMonitoringEmailSummary } from "../notification/monitoring_email";
import {
  getMonitorForUpdate,
  getMonitorPage,
  countMonitorCheckPages,
  hashMonitorUrl,
  insertMonitorCheckPages,
  listActiveMonitorPages,
  listMonitorCheckPages,
  listRunningMonitorChecks,
  markMonitorRunning,
  updateMonitorCheck,
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

const logger = _logger.child({ module: "monitoring-runner" });
const poll = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type PageResult = MonitorCheckPageInsert & {
  emailStatus?: string;
};

function withMonitorScrapeDefaults(
  options: Record<string, unknown>,
): ScrapeOptions {
  return {
    maxAge: 0,
    ...withMarkdownFormat(options),
  };
}

function getDocumentUrl(doc: any, fallback: string): string {
  return doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? doc?.url ?? fallback;
}

function getDocumentStatusCode(doc: any): number | null {
  return typeof doc?.metadata?.statusCode === "number"
    ? doc.metadata.statusCode
    : null;
}

function estimateActualCredits(doc: any, options: any): number {
  if (typeof doc?.metadata?.creditsUsed === "number") {
    return doc.metadata.creditsUsed;
  }
  const formats = Array.isArray(options?.formats) ? options.formats : [];
  const hasJson = formats.some((format: any) =>
    typeof format === "string" ? format === "json" : format?.type === "json",
  );
  return hasJson ? 5 : 1;
}

async function runSingleScrape(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
  url: string;
  requestId?: string;
}): Promise<{ scrapeId: string; doc: any; credits: number }> {
  const scrapeId = uuidv7();
  const scrapeOptions = scrapeRequestSchema.parse({
    url: params.url,
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
      team_id: params.monitor.team_id,
      scrapeOptions,
      internalOptions: {
        teamId: params.monitor.team_id,
        saveScrapeResultToGCS: !!config.GCS_FIRE_ENGINE_BUCKET_NAME,
        bypassBilling: true,
        zeroDataRetention: false,
      },
      skipNuq: true,
      origin: "monitor",
      integration: null,
      billing: { endpoint: "monitor", jobId: params.check.id },
      requestId: params.requestId,
      zeroDataRetention: false,
      apiKeyId: null,
    },
  };

  const doc = await processJobInternal(job);
  return {
    scrapeId,
    doc,
    credits: estimateActualCredits(doc, scrapeOptions),
  };
}

async function diffAndPersistPage(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
  url: string;
  scrapeId: string;
  doc: any;
  source: "explicit" | "discovered";
}): Promise<PageResult> {
  const previous = await getMonitorPage({
    monitorId: params.monitor.id,
    targetId: params.target.id,
    url: params.url,
  });

  let status: PageResult["status"] = "new";
  let diffGcsKey: string | null = null;
  let diffTextBytes: number | null = null;
  let diffJsonBytes: number | null = null;

  if (previous?.last_scrape_id && !previous.is_removed) {
    const previousDoc = (await getJobFromGCS(previous.last_scrape_id))?.[0];
    const previousMarkdown = previousDoc?.markdown;
    const currentMarkdown = params.doc?.markdown;

    if (previousMarkdown && currentMarkdown) {
      const diff = diffMonitorMarkdown(previousMarkdown, currentMarkdown);
      status = diff.status;

      if (diff.status === "changed") {
        diffGcsKey = monitorDiffGcsKey({
          teamId: params.monitor.team_id,
          monitorId: params.monitor.id,
          checkId: params.check.id,
          pageId: uuidv7(),
        });
        const sizes = await saveMonitorDiffArtifact(diffGcsKey, {
          url: params.url,
          previousScrapeId: previous.last_scrape_id,
          currentScrapeId: params.scrapeId,
          text: diff.text,
          json: diff.json,
          generatedAt: new Date().toISOString(),
        });
        diffTextBytes = sizes.textBytes;
        diffJsonBytes = sizes.jsonBytes;
      }
    } else {
      status = "changed";
    }
  }

  await upsertMonitorPage({
    monitorId: params.monitor.id,
    teamId: params.monitor.team_id,
    targetId: params.target.id,
    url: params.url,
    source: params.source,
    checkId: params.check.id,
    scrapeId: params.scrapeId,
    status,
    metadata: {
      title: params.doc?.metadata?.title ?? null,
      statusCode: getDocumentStatusCode(params.doc),
    },
  });

  return {
    check_id: params.check.id,
    monitor_id: params.monitor.id,
    team_id: params.monitor.team_id,
    target_id: params.target.id,
    url: params.url,
    url_hash: hashMonitorUrl(params.url),
    status,
    previous_scrape_id: previous?.last_scrape_id ?? null,
    current_scrape_id: params.scrapeId,
    diff_gcs_key: diffGcsKey,
    diff_text_bytes: diffTextBytes,
    diff_json_bytes: diffJsonBytes,
    status_code: getDocumentStatusCode(params.doc),
    metadata: {
      title: params.doc?.metadata?.title ?? null,
    },
    emailStatus: status,
  };
}

async function runScrapeTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
}): Promise<{ pages: PageResult[]; credits: number; targetResult: any }> {
  if (params.target.type !== "scrape") {
    return { pages: [], credits: 0, targetResult: null };
  }

  const pages: PageResult[] = [];
  let credits = 0;

  for (const url of params.target.urls) {
    try {
      const result = await runSingleScrape({
        monitor: params.monitor,
        check: params.check,
        target: params.target,
        url,
      });
      credits += result.credits;
      pages.push(
        await diffAndPersistPage({
          monitor: params.monitor,
          check: params.check,
          target: params.target,
          url,
          scrapeId: result.scrapeId,
          doc: result.doc,
          source: "explicit",
        }),
      );
    } catch (error) {
      pages.push({
        check_id: params.check.id,
        monitor_id: params.monitor.id,
        team_id: params.monitor.team_id,
        target_id: params.target.id,
        url,
        url_hash: hashMonitorUrl(url),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        emailStatus: "error",
      });
    }
  }

  return {
    pages,
    credits,
    targetResult: {
      targetId: params.target.id,
      type: params.target.type,
      pages: pages.length,
      credits,
    },
  };
}

async function runCrawlTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
}): Promise<{ pages: PageResult[]; credits: number; targetResult: any }> {
  if (params.target.type !== "crawl") {
    return { pages: [], credits: 0, targetResult: null };
  }

  const crawlId = uuidv7();
  const body = crawlRequestSchema.parse({
    url: params.target.url,
    ...(params.target.crawlOptions ?? {}),
    scrapeOptions: withMarkdownFormat(params.target.scrapeOptions ?? {}),
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
    // Crawls tolerate robots fetch failures in the public controller too.
  }

  await crawlGroup.addGroup(crawlId, sc.team_id, 24 * 60 * 60 * 1000);
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
    },
    uuidv7(),
  );

  const started = Date.now();
  let status = "scraping";
  let total = 0;
  while (Date.now() - started < 30 * 60 * 1000) {
    const group = await crawlGroup.getGroup(crawlId);
    const stats = await scrapeQueue.getGroupNumericStats(crawlId, logger);
    status = group?.status ?? "scraping";
    total =
      (stats.completed ?? 0) +
      (stats.active ?? 0) +
      (stats.queued ?? 0) +
      (stats.backlog ?? 0);
    if (status !== "active" && status !== "scraping") break;
    await poll(1000);
  }

  const doneJobs = await scrapeQueue.getCrawlJobsForListing(
    crawlId,
    Math.max(total, 1),
    0,
    logger,
  );

  const pages: PageResult[] = [];
  const seen = new Set<string>();
  let credits = 0;

  for (const job of doneJobs) {
    const doc = job.returnvalue ?? (await getJobFromGCS(job.id))?.[0];
    if (!doc) continue;
    const url = getDocumentUrl(doc, (job.data as any)?.url ?? body.url);
    seen.add(hashMonitorUrl(url));
    credits += estimateActualCredits(doc, body.scrapeOptions);
    pages.push(
      await diffAndPersistPage({
        monitor: params.monitor,
        check: params.check,
        target: params.target,
        url,
        scrapeId: job.id,
        doc,
        source: "discovered",
      }),
    );
  }

  if (status === "completed") {
    const previousPages = await listActiveMonitorPages({
      monitorId: params.monitor.id,
      targetId: params.target.id,
    });
    for (const previous of previousPages) {
      if (seen.has(previous.url_hash)) continue;
      await upsertMonitorPage({
        monitorId: params.monitor.id,
        teamId: params.monitor.team_id,
        targetId: params.target.id,
        url: previous.url,
        source: previous.source,
        checkId: params.check.id,
        scrapeId: previous.last_scrape_id,
        status: "removed",
        metadata: previous.metadata,
      });
      pages.push({
        check_id: params.check.id,
        monitor_id: params.monitor.id,
        team_id: params.monitor.team_id,
        target_id: params.target.id,
        url: previous.url,
        url_hash: previous.url_hash,
        status: "removed",
        previous_scrape_id: previous.last_scrape_id,
        current_scrape_id: null,
        emailStatus: "removed",
      });
    }
  }

  return {
    pages,
    credits,
    targetResult: {
      targetId: params.target.id,
      type: params.target.type,
      crawlId,
      status,
      pages: pages.length,
      credits,
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
      subscription_id: undefined,
      credits: params.actualCredits,
      billing: { endpoint: "monitor", jobId: params.check.id },
      is_extract: false,
      timestamp: new Date().toISOString(),
      originating_job_id: params.check.id,
      api_key_id: null,
      autumnTrackInRequest: Boolean(params.lockId),
    },
    {
      jobId: uuidv7(),
      priority: 10,
    },
  );
}

async function sendNotifications(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: PageResult[];
}): Promise<{ webhook?: unknown; email?: unknown }> {
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
    await sender?.send(WebhookEvent.MONITOR_CHECK_COMPLETED, {
      success: params.check.status === "completed",
      data: payload,
      error: params.check.error ?? undefined,
    });
    webhookStatus = { attempted: true, success: true };
  }

  const emailStatus = await sendMonitoringEmailSummary({
    monitor: params.monitor,
    check: params.check,
    pages: params.pages
      .filter(page => page.status !== "same")
      .slice(0, 25)
      .map(page => ({
        url: page.url,
        status: page.status,
        error: page.error,
      })),
  });

  return {
    webhook: webhookStatus,
    email: emailStatus,
  };
}

async function enqueueMonitorScrapeTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
}): Promise<{ targetId: string; type: "scrape"; expectedJobs: string[] }> {
  if (params.target.type !== "scrape") {
    throw new Error("Expected scrape target");
  }

  const expectedJobs: string[] = [];
  for (const url of params.target.urls) {
    const scrapeId = uuidv7();
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
    expectedJobs.push(scrapeId);
  }

  return { targetId: params.target.id, type: "scrape", expectedJobs };
}

async function enqueueMonitorCrawlTarget(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  target: MonitorTarget;
}): Promise<{ targetId: string; type: "crawl"; crawlId: string }> {
  if (params.target.type !== "crawl") {
    throw new Error("Expected crawl target");
  }

  const crawlId = uuidv7();
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
    // Non-fatal, same as the public crawl controller.
  }

  await crawlGroup.addGroup(crawlId, sc.team_id, 24 * 60 * 60 * 1000);
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

  return { targetId: params.target.id, type: "crawl", crawlId };
}

export async function processMonitorCheckJob(
  job: MonitorCheckJobData,
): Promise<void> {
  const monitor = await getMonitorForUpdate(job.teamId, job.monitorId);
  if (!monitor) {
    throw new Error("Monitor not found");
  }

  await markMonitorRunning({
    monitorId: monitor.id,
    checkId: job.checkId,
  });

  let check = await updateMonitorCheck(job.checkId, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  let lockId: string | null = null;
  try {
    lockId = await autumnService.lockCredits({
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

    check = await updateMonitorCheck(check.id, {
      autumn_lock_id: lockId,
      reserved_credits: lockId ? (check.estimated_credits ?? 1) : null,
      billing_status: lockId ? "reserved" : "not_applicable",
    });

    const targetResults: unknown[] = [];

    for (const target of monitor.targets) {
      const result =
        target.type === "scrape"
          ? await enqueueMonitorScrapeTarget({ monitor, check, target })
          : await enqueueMonitorCrawlTarget({ monitor, check, target });
      targetResults.push(result);
    }

    await updateMonitorCheck(check.id, {
      target_results: targetResults,
    });
  } catch (error) {
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

    check = await updateMonitorCheck(check.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      billing_status: lockId ? "released" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });

    await sendNotifications({
      monitor,
      check,
      pages: [],
    }).catch(err =>
      logger.warn("Failed to send monitor failure notifications", {
        error: err,
      }),
    );

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
      limit: 100000,
      skip: 0,
    });
    const seen = new Set(
      checkPages
        .filter(page => page.target_id === target.targetId)
        .map(page => page.url_hash),
    );
    const activePages = await listActiveMonitorPages({
      monitorId: params.monitor.id,
      targetId: target.targetId,
    });

    const removed: MonitorCheckPageInsert[] = [];
    for (const previous of activePages) {
      if (seen.has(previous.url_hash)) continue;
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
): Promise<boolean> {
  const targetResults = Array.isArray(check.target_results)
    ? (check.target_results as any[])
    : [];

  if (targetResults.length === 0) return false;

  for (const target of targetResults) {
    if (target?.type === "scrape") {
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
      if (!monitor) continue;

      const targetResults = Array.isArray(check.target_results)
        ? ([...check.target_results] as any[])
        : [];

      await processRemovedPagesForCompletedCrawls({
        monitor,
        check,
        targetResults,
      });

      if (
        !(await isMonitorCheckComplete({
          ...check,
          target_results: targetResults,
        }))
      ) {
        await updateMonitorCheck(check.id, { target_results: targetResults });
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
      const actualCredits = totalPages;

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

      let notificationStatus: { webhook?: unknown; email?: unknown } | null =
        null;
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
