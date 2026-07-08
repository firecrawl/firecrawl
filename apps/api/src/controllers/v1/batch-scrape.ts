import { Response } from "express";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  BatchScrapeRequest,
  batchScrapeRequestSchema,
  batchScrapeRequestSchemaNoURLValidation,
  url as urlSchema,
  RequestWithAuth,
  BatchScrapeResponse,
} from "./types";
import {
  addCrawlJobs,
  finishCrawlKickoff,
  getCrawl,
  lockURLs,
  markCrawlActive,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { getJobPriority } from "../../lib/job-priority";
import { addScrapeJobs } from "../../services/queue-jobs";
import { createWebhookSender, WebhookEvent } from "../../services/webhook";
import { logger as _logger } from "../../lib/logger";
import { UNSUPPORTED_SITE_MESSAGE } from "../../lib/strings";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { fromV1ScrapeOptions } from "../v2/types";
import { checkPermissions } from "../../lib/permissions";
import {
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
import { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
import { calculateThreatScanCredits } from "../../lib/scrape-billing";
import { billTeam } from "../../services/billing/credit_billing";
import {
  actionTypesOf,
  checkKeyFormatRestriction,
  formatTypesOf,
} from "../../lib/key-restriction";
import {
  crawlGroup,
  resolveNewGroupBackend,
} from "../../services/worker/nuq-router";
import { logRequest } from "../../services/logging/log_job";
import { getScrapeZDR } from "../../lib/zdr-helpers";

export async function batchScrapeController(
  req: RequestWithAuth<{}, BatchScrapeResponse, BatchScrapeRequest>,
  res: Response<BatchScrapeResponse>,
) {
  const preNormalizedBody = { ...req.body };
  if (req.body?.ignoreInvalidURLs === true) {
    req.body = batchScrapeRequestSchemaNoURLValidation.parse(req.body);
  } else {
    req.body = batchScrapeRequestSchema.parse(req.body);
  }

  const threatProtection = await resolveThreatProtection({
    teamId: req.auth.team_id,
    orgId: req.acuc?.org_id ?? null,
    flags: req.acuc?.flags ?? null,
    override: req.body.threatProtection,
  });
  if (threatProtection.error) {
    return res.status(403).json({
      success: false,
      error: threatProtection.error,
    });
  }

  const permissions = checkPermissions(req.body, req.acuc?.flags, {
    threatProtectionOrgConfig: threatProtection.orgConfig,
  });
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const keyRestriction = await checkKeyFormatRestriction(
    formatTypesOf(req.body.formats),
    actionTypesOf(req.body.actions),
    req.acuc?.api_key_id,
    req.acuc?.flags ?? null,
  );
  if (!keyRestriction.allowed) {
    return res.status(keyRestriction.status).json({
      success: false,
      error: keyRestriction.error,
    });
  }

  const zeroDataRetention =
    getScrapeZDR(req.acuc?.flags) === "forced" || req.body.zeroDataRetention;

  const id = req.body.appendToId ?? uuidv7();
  const logger = _logger.child({
    crawlId: id,
    batchScrapeId: id,
    module: "api/v1",
    method: "batchScrapeController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  let urls: string[] = req.body.urls;
  let unnormalizedURLs = preNormalizedBody.urls;
  let invalidURLs: string[] | undefined = undefined;

  if (req.body.ignoreInvalidURLs) {
    invalidURLs = [];

    let pendingURLs = urls;
    urls = [];
    unnormalizedURLs = [];
    for (const u of pendingURLs) {
      try {
        const nu = urlSchema.parse(u);
        if (
          !isUrlBlocked(nu, req.acuc?.flags ?? null, {
            team_id: req.auth.team_id,
            origin: req.body.origin ?? null,
          })
        ) {
          urls.push(nu);
          unnormalizedURLs.push(u);
        } else {
          invalidURLs.push(u);
        }
      } catch (_) {
        invalidURLs.push(u);
      }
    }
  } else {
    if (
      req.body.urls?.some((url: string) =>
        isUrlBlocked(url, req.acuc?.flags ?? null, {
          team_id: req.auth.team_id,
          origin: req.body.origin ?? null,
        }),
      )
    ) {
      if (!res.headersSent) {
        return res.status(403).json({
          success: false,
          error: UNSUPPORTED_SITE_MESSAGE,
        });
      }
    }
  }

  // Threat protection: reject/report blocked URLs at enqueue time so they
  // never consume scrape slots (mirrors the isUrlBlocked handling above).
  if (threatProtection.policy) {
    const { blocked, decisionsByUrl } = await checkUrlsAgainstThreatPolicy(
      urls,
      threatProtection.policy,
      { teamId: req.auth.team_id },
    );
    if (blocked.length > 0) {
      // Consulted decisions bill the scan fee (+2 per unique scanned URL) —
      // the scans already happened. With ignoreInvalidURLs the allowed URLs
      // proceed to scrape jobs that bill their own scans, so only blocked
      // ones bill here; when the whole request is rejected below, no scrape
      // jobs will ever run, so every scanned URL bills here.
      const threatScanCredits = calculateThreatScanCredits(
        req.body.ignoreInvalidURLs
          ? blocked.map(x => x.decision)
          : decisionsByUrl.values(),
      );
      if (threatScanCredits > 0) {
        billTeam(
          req.auth.team_id,
          req.acuc?.sub_id ?? undefined,
          threatScanCredits,
          req.acuc?.api_key_id ?? null,
          { endpoint: "batch_scrape", jobId: id },
        ).catch(error => {
          logger.error(
            `Failed to bill team ${req.auth.team_id} for ${threatScanCredits} threat scan credit(s): ${error}`,
          );
        });
      }
      if (req.body.ignoreInvalidURLs) {
        const blockedSet = new Set(blocked.map(x => x.url));
        const keptUnnormalized: string[] = [];
        const keptUrls: string[] = [];
        urls.forEach((u, i) => {
          if (blockedSet.has(u)) {
            invalidURLs!.push(unnormalizedURLs[i] ?? u);
          } else {
            keptUrls.push(u);
            keptUnnormalized.push(unnormalizedURLs[i]);
          }
        });
        urls = keptUrls;
        unnormalizedURLs = keptUnnormalized;
      } else {
        const first = blocked[0];
        const error = new UnsafeDomainBlockedError(first.url, first.decision);
        return res.status(403).json({
          success: false,
          code: error.code,
          error: error.message,
        });
      }
    }
  }

  if (urls.length === 0) {
    return res.status(400).json({
      success: false,
      error: "No valid URLs provided",
    });
  }

  logger.debug("Batch scrape " + id + " starting", {
    urlsLength: urls.length,
    appendToId: req.body.appendToId,
    account: req.account,
  });

  if (!req.body.appendToId) {
    await logRequest({
      id,
      kind: "batch_scrape",
      api_version: "v1",
      team_id: req.auth.team_id,
      origin: req.body.origin ?? "api",
      integration: req.body.integration,
      target_hint: urls[0] ?? "",
      zeroDataRetention: zeroDataRetention || false,
      api_key_id: req.acuc?.api_key_id ?? null,
    });
  }

  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
    req.body,
    req.body.timeout,
    req.auth.team_id,
  );

  const sc: StoredCrawl = req.body.appendToId
    ? ((await getCrawl(req.body.appendToId)) as StoredCrawl)
    : {
        crawlerOptions: null,
        scrapeOptions,
        internalOptions: {
          ...internalOptions,
          disableSmartWaitCache: true,
          teamId: req.auth.team_id,
          saveScrapeResultToGCS: config.GCS_FIRE_ENGINE_BUCKET_NAME
            ? true
            : false,
          zeroDataRetention,
          agentIndexOnly: (req as any).agentIndexOnly ?? false,
          threatProtection: threatProtection.policy ?? undefined,
        }, // NOTE: smart wait disabled for batch scrapes to ensure contentful scrape, speed does not matter
        team_id: req.auth.team_id,
        createdAt: Date.now(),
        maxConcurrency: req.body.maxConcurrency,
        zeroDataRetention,
        v1: true,
        webhook: req.body.webhook,
      };

  if (req.body.appendToId && (!sc || sc.team_id !== req.auth.team_id)) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  if (!req.body.appendToId) {
    sc.queueBackend = await resolveNewGroupBackend(sc.team_id);
    await crawlGroup.addGroup(
      id,
      sc.team_id,
      (req.acuc?.flags?.crawlTtlHours ?? 24) * 60 * 60 * 1000,
      {
        backend: sc.queueBackend,
        maxConcurrency: sc.maxConcurrency,
        delaySeconds: sc.crawlerOptions?.delay,
      },
    );
    await saveCrawl(id, sc);
    await markCrawlActive(id);
  }

  let jobPriority = 20;

  // If it is over 1000, we need to get the job priority,
  // otherwise we can use the default priority of 20
  if (urls.length > 1000) {
    // set base to 21
    jobPriority = await getJobPriority({
      team_id: req.auth.team_id,
      basePriority: 21,
    });
  }
  logger.debug("Using job priority " + jobPriority, { jobPriority });
  const billing = { endpoint: "batch_scrape" as const, jobId: id };

  const jobs = urls.map(x => ({
    jobId: uuidv7(),
    data: {
      url: x,
      mode: "single_urls" as const,
      team_id: req.auth.team_id,
      crawlerOptions: null,
      scrapeOptions,
      origin: "api",
      integration: req.body.integration,
      billing,
      crawl_id: id,
      sitemapped: true,
      v1: true,
      webhook: req.body.webhook,
      internalOptions: sc.internalOptions,
      zeroDataRetention: zeroDataRetention ?? false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    priority: jobPriority,
  }));

  await finishCrawlKickoff(id);

  logger.debug("Locking URLs...");
  await lockURLs(
    id,
    sc,
    jobs.map(x => x.data.url),
    logger,
  );
  logger.debug("Adding scrape jobs to Redis...");
  await addCrawlJobs(
    id,
    jobs.map(x => x.jobId),
    logger,
  );
  logger.debug("Adding scrape jobs to BullMQ...");
  await addScrapeJobs(jobs);

  if (req.body.webhook) {
    logger.debug("Calling webhook with batch_scrape.started...", {
      webhook: req.body.webhook,
    });
    const sender = await createWebhookSender({
      teamId: req.auth.team_id,
      jobId: id,
      webhook: req.body.webhook,
      v0: false,
    });
    await sender?.send(WebhookEvent.BATCH_SCRAPE_STARTED, { success: true });
  }

  const protocol = req.protocol;

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.host}/v1/batch/scrape/${id}`,
    invalidURLs,
  });
}
