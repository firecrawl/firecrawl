import { Response } from "express";
import { logger as _logger } from "../../lib/logger";
import {
  Document,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { v7 as uuidv7 } from "uuid";
import { getJobPriority } from "../../lib/job-priority";
import { fromV1ScrapeOptions } from "../v2/types";
import { TransportableError } from "../../lib/error";
import { NuQJob } from "../../services/worker/nuq";
import { checkPermissions } from "../../lib/permissions";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import { processJobInternal } from "../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../types";
import { AbortManagerThrownError } from "../../scraper/scrapeURL/lib/abortManager";

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>,
) {
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId: string = uuidv7();
  const preNormalizedBody = { ...req.body };
  req.body = scrapeRequestSchema.parse(req.body);

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const zeroDataRetention =
    req.acuc?.flags?.forceZDR || req.body.zeroDataRetention;

  const logger = _logger.child({
    method: "scrapeController",
    jobId,
    noq: true,
    scrapeId: jobId,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    zeroDataRetention,
  });

  const middlewareTime = controllerStartTime - middlewareStartTime;

  logger.debug("Scrape " + jobId + " starting", {
    version: "v1",
    scrapeId: jobId,
    request: req.body,
    originalRequest: preNormalizedBody,
    account: req.account,
  });

  const origin = req.body.origin;
  const timeout = req.body.timeout;

  // const startTime = new Date().getTime();

  const isDirectToBullMQ =
    process.env.SEARCH_PREVIEW_TOKEN !== undefined &&
    process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
    req.body,
    req.body.timeout,
    req.auth.team_id,
  );

  const totalWait =
    (req.body.waitFor ?? 0) +
    (req.body.actions ?? []).reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 0) : 0) + a,
      0,
    );

  let timeoutHandle: NodeJS.Timeout | null = null;
  let doc: Document | null = null;
  try {
    const lockStart = Date.now();
    const aborter = new AbortController();
    if (timeout) {
      timeoutHandle = setTimeout(() => {
        aborter.abort();
      }, timeout * 0.667);
    }
    req.on("close", () => aborter.abort());

    doc = await teamConcurrencySemaphore.withSemaphore(
      req.auth.team_id,
      jobId,
      req.acuc?.concurrency || 1,
      aborter.signal,
      timeout ?? 60_000,
      async limited => {
        const jobPriority = await getJobPriority({
          team_id: req.auth.team_id,
          basePriority: 10,
        });

        const lockTime = Date.now() - lockStart;

        logger.debug(`Lock acquired for team: ${req.auth.team_id}`, {
          teamId: req.auth.team_id,
          lockTime,
        });

        const job: NuQJob<ScrapeJobData> = {
          id: jobId,
          status: "active",
          createdAt: new Date(),
          priority: jobPriority,
          data: {
            url: req.body.url,
            mode: "single_urls",
            team_id: req.auth.team_id,
            scrapeOptions,
            internalOptions: {
              ...internalOptions,
              teamId: req.auth.team_id,
              saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
                ? true
                : false,
              unnormalizedSourceURL: preNormalizedBody.url,
              bypassBilling: isDirectToBullMQ,
              zeroDataRetention,
              teamFlags: req.acuc?.flags ?? null,
            },
            skipNuq: true,
            origin,
            integration: req.body.integration,
            startTime: controllerStartTime,
            zeroDataRetention: zeroDataRetention ?? false,
            apiKeyId: req.acuc?.api_key_id ?? null,
            concurrencyLimited: limited,
          },
        };

        const doc = await processJobInternal(job);
        return doc ?? null;
      },
    );
  } catch (e) {
    const timeoutErr =
      e instanceof TransportableError && e.code === "SCRAPE_TIMEOUT";

    if (!timeoutErr) {
      logger.error(`Error in scrapeController`, {
        version: "v1",
        error: e,
      });
    }

    if (e instanceof TransportableError) {
      // DNS resolution errors should return 200 with success: false
      if (e.code === "SCRAPE_DNS_RESOLUTION_ERROR") {
        return res.status(200).json({
          success: false,
          code: e.code,
          error: e.message,
        });
      }

      return res.status(e.code === "SCRAPE_TIMEOUT" ? 408 : 500).json({
        success: false,
        code: e.code,
        error: e.message,
      });
    } else {
      return res.status(500).json({
        success: false,
        code: "UNKNOWN_ERROR",
        error: `(Internal server error) - ${e && e.message ? e.message : e}`,
      });
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  logger.info("Done with waitForJob");

  logger.info("Removed job from queue");

  if (!req.body.formats.includes("rawHtml")) {
    if (doc && doc.rawHtml) {
      delete doc.rawHtml;
    }
  }

  const totalRequestTime = new Date().getTime() - middlewareStartTime;
  const controllerTime = new Date().getTime() - controllerStartTime;

  let usedLlm =
    req.body.formats?.includes("json") ||
    req.body.formats?.includes("summary") ||
    req.body.formats?.includes("branding") ||
    req.body.formats?.includes("extract");

  if (
    !usedLlm &&
    req.body.formats?.includes("changeTracking") &&
    req.body.changeTrackingOptions?.modes?.includes("json")
  ) {
    usedLlm = true;
  }

  logger.info("Request metrics", {
    version: "v1",
    mode: "scrape",
    scrapeId: jobId,
    middlewareStartTime,
    controllerStartTime,
    middlewareTime,
    controllerTime,
    totalRequestTime,
    totalWait,
    usedLlm,
    formats: req.body.formats,
  });

  return res.status(200).json({
    success: true,
    data: doc!,
    scrape_id: origin?.includes("website") ? jobId : undefined,
  });
}
