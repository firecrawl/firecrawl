import { Response } from "express";
import { config } from "../../config";
import { v7 as uuidv7 } from "uuid";
import {
  CrawlRequest,
  crawlRequestSchema,
  CrawlResponse,
  RequestWithAuth,
  toLegacyCrawlerOptions,
} from "./types";
import {
  crawlToCrawler,
  saveCrawl,
  StoredCrawl,
  markCrawlActive,
} from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../../services/queue-jobs";
import { logger as _logger } from "../../lib/logger";
import { fromV1ScrapeOptions } from "../v2/types";
import { checkPermissions } from "../../lib/permissions";
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
import { resolveThreatProtection } from "../../lib/threat-protection/request";
import { checkUrl } from "../../lib/threat-protection";
import { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
import { calculateThreatScanCredits } from "../../lib/scrape-billing";
import { billTeam } from "../../services/billing/credit_billing";

export async function crawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>,
) {
  const preNormalizedBody = req.body;
  req.body = crawlRequestSchema.parse(req.body);

  const threatProtection = await resolveThreatProtection({
    teamId: req.auth.team_id,
    orgId: req.acuc?.org_id ?? null,
    flags: req.acuc?.flags ?? null,
    override: req.body.scrapeOptions?.threatProtection,
  });
  if (threatProtection.error) {
    return res.status(403).json({
      success: false,
      error: threatProtection.error,
    });
  }

  const permissions = checkPermissions(
    { ...req.body, crawlerOptions: req.body },
    req.acuc?.flags,
    { threatProtectionOrgConfig: threatProtection.orgConfig },
  );
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  // Threat protection: check the seed URL before kicking off the crawl.
  if (threatProtection.policy) {
    const decision = await checkUrl(req.body.url, threatProtection.policy, {
      teamId: req.auth.team_id,
    });
    if (!decision.allowed) {
      // A blocked seed still bills the scan fee when the classifier was
      // consulted — the scan already happened. (An allowed seed is not billed
      // here: its scrape job re-checks the cached verdict and bills there.)
      const threatScanCredits = calculateThreatScanCredits([decision]);
      if (threatScanCredits > 0) {
        billTeam(
          req.auth.team_id,
          threatScanCredits,
          req.acuc?.api_key_id ?? null,
          { endpoint: "crawl" },
        ).catch(error => {
          _logger.error(
            `Failed to bill team ${req.auth.team_id} for ${threatScanCredits} threat scan credit(s): ${error}`,
          );
        });
      }
      const error = new UnsafeDomainBlockedError(req.body.url, decision);
      return res.status(403).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }
  }

  const keyRestriction = await checkKeyFormatRestriction(
    formatTypesOf(req.body.scrapeOptions?.formats),
    actionTypesOf(req.body.scrapeOptions?.actions),
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

  const id = uuidv7();
  const logger = _logger.child({
    crawlId: id,
    module: "api/v1",
    method: "crawlController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  logger.debug("Crawl " + id + " starting", {
    request: req.body,
    originalRequest: preNormalizedBody,
    account: req.account,
  });

  await logRequest({
    id,
    kind: "crawl",
    api_version: "v1",
    team_id: req.auth.team_id,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    target_hint: req.body.url,
    zeroDataRetention: zeroDataRetention || false,
    api_key_id: req.acuc?.api_key_id ?? null,
  });

  // checkCreditsMiddleware (always runs before this controller) is the source
  // of truth: Infinity when Autumn allows the request, the real remaining when
  // it clamps a low-credit crawl. Default to no clamp if it's somehow unset.
  let remainingCredits = req.account?.remainingCredits ?? Infinity;
  const useDbAuthentication = config.USE_DB_AUTHENTICATION;
  if (!useDbAuthentication) {
    remainingCredits = Infinity;
  }

  const crawlerOptions = {
    ...req.body,
    url: undefined,
    scrapeOptions: undefined,
  };

  const bodyScrapeOptions =
    req.body.scrapeOptions ?? ({} as typeof req.body.scrapeOptions);
  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
    bodyScrapeOptions,
    bodyScrapeOptions.timeout,
    req.auth.team_id,
  );

  // TODO: @rafa, is this right? copied from v0
  if (Array.isArray(crawlerOptions.includePaths)) {
    for (const x of crawlerOptions.includePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  if (Array.isArray(crawlerOptions.excludePaths)) {
    for (const x of crawlerOptions.excludePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  const originalLimit = crawlerOptions.limit;
  crawlerOptions.limit = Math.min(remainingCredits, crawlerOptions.limit);
  logger.debug("Determined limit: " + crawlerOptions.limit, {
    remainingCredits,
    bodyLimit: originalLimit,
    originalBodyLimit: preNormalizedBody.limit,
  });

  const sc: StoredCrawl = {
    originUrl: req.body.url,
    crawlerOptions: toLegacyCrawlerOptions(crawlerOptions),
    scrapeOptions,
    internalOptions: {
      ...internalOptions,
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      saveScrapeResultToGCS: config.GCS_FIRE_ENGINE_BUCKET_NAME ? true : false,
      zeroDataRetention,
      agentIndexOnly: (req as any).agentIndexOnly ?? false,
      threatProtection: threatProtection.policy ?? undefined,
    }, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    maxConcurrency:
      req.body.maxConcurrency !== undefined
        ? req.acuc?.concurrency !== undefined
          ? Math.min(req.body.maxConcurrency, req.acuc.concurrency)
          : req.body.maxConcurrency
        : undefined,
    zeroDataRetention,
    v1: true,
    webhook: req.body.webhook,
  };

  const crawler = crawlToCrawler(id, sc, req.acuc?.flags ?? null);

  try {
    sc.robots = await crawler.getRobotsTxt(scrapeOptions.skipTlsVerification);
    // const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
    // if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
    //   sc.crawlerOptions.delay = robotsCrawlDelay;
    // }
  } catch (e) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error: e,
    });
  }

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

  await _addScrapeJobToBullMQ(
    {
      mode: "kickoff" as const,
      url: req.body.url,
      team_id: req.auth.team_id,
      crawlerOptions,
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: req.body.origin,
      integration: req.body.integration,
      billing: { endpoint: "crawl", jobId: id },
      crawl_id: id,
      webhook: req.body.webhook,
      v1: true,
      zeroDataRetention: zeroDataRetention || false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    uuidv7(),
  );

  const protocol = req.protocol;

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.host}/v1/crawl/${id}`,
  });
}
