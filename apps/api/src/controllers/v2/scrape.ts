import { Response } from "express";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  Document,
  FormatObject,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { v7 as uuidv7 } from "uuid";
import { hasFormatOfType } from "../../lib/format-utils";
import { TransportableError } from "../../lib/error";
import { NuQJob } from "../../services/worker/nuq";
import { checkPermissions } from "../../lib/permissions";
import { withSpan, setSpanAttributes, SpanKind } from "../../lib/otel-tracer";
import { processJobInternal } from "../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../types";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import { getJobPriority } from "../../lib/job-priority";
import { logRequest } from "../../services/logging/log_job";

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>,
) {
  return withSpan(
    "api.scrape.request",
    async span => {
      // Get timing data from middleware (includes all middleware processing time)
      const middlewareStartTime =
        (req as any).requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();

      const jobId = uuidv7();
      const preNormalizedBody = { ...req.body };

      // Set initial span attributes
      setSpanAttributes(span, {
        "scrape.job_id": jobId,
        "scrape.url": req.body.url,
        "scrape.team_id": req.auth.team_id,
        "scrape.api_key_id": req.acuc?.api_key_id,
        "scrape.middleware_time_ms": controllerStartTime - middlewareStartTime,
      });

      // Validation span
      await withSpan("api.scrape.validate", async validateSpan => {
        req.body = scrapeRequestSchema.parse(req.body);
        setSpanAttributes(validateSpan, {
          "validation.success": true,
        });
      });

      // Permission check span
      const permissions = await withSpan(
        "api.scrape.check_permissions",
        async permSpan => {
          const perms = checkPermissions(req.body, req.acuc?.flags);
          setSpanAttributes(permSpan, {
            "permissions.success": !perms.error,
            "permissions.error": perms.error,
          });
          return perms;
        },
      );

      if (permissions.error) {
        setSpanAttributes(span, {
          "scrape.error": permissions.error,
          "scrape.status_code": 403,
        });
        return res.status(403).json({
          success: false,
          error: permissions.error,
        });
      }

      const zeroDataRetention =
        req.acuc?.flags?.forceZDR || (req.body.zeroDataRetention ?? false);

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
        version: "v2",
        scrapeId: jobId,
        request: req.body,
        originalRequest: preNormalizedBody,
        account: req.account,
      });

      await logRequest({
        id: jobId,
        kind: "scrape",
        api_version: "v2",
        team_id: req.auth.team_id,
        origin: req.body.origin ?? "api",
        integration: req.body.integration,
        target_hint: req.body.url,
        zeroDataRetention: zeroDataRetention || false,
        api_key_id: req.acuc?.api_key_id ?? null,
      });

      setSpanAttributes(span, {
        "scrape.zero_data_retention": zeroDataRetention,
        "scrape.origin": req.body.origin,
        "scrape.timeout": req.body.timeout,
      });

      const origin = req.body.origin;
      const timeout = req.body.timeout;

      const isDirectToBullMQ =
        config.SEARCH_PREVIEW_TOKEN !== undefined &&
        config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

      const totalWait =
        (req.body.waitFor ?? 0) +
        (req.body.actions ?? []).reduce(
          (a, x) => (x.type === "wait" ? (x.milliseconds ?? 0) : 0) + a,
          0,
        );

      let lockTime: number | null = null;
      let concurrencyLimited: boolean = false;

      let timeoutHandle: NodeJS.Timeout | null = null;
      let doc: Document | null = null;

      try {
        const lockStart = Date.now();
        const aborter = new AbortController();
        if (timeout) {
          // Semaphore has 2/3 of the timeout time to get a lock to allow for scrape time
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

            lockTime = Date.now() - lockStart;
            concurrencyLimited = limited;

            logger.debug(`Lock acquired for team: ${req.auth.team_id}`, {
              teamId: req.auth.team_id,
              lockTime,
              limited,
            });

            // Wait for job completion span
            const doc = await withSpan(
              "api.scrape.wait_for_job",
              async waitSpan => {
                setSpanAttributes(waitSpan, {
                  "wait.timeout":
                    timeout !== undefined ? timeout + totalWait : undefined,
                  "wait.job_id": jobId,
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
                    scrapeOptions: {
                      ...req.body,
                      ...((req.body as any).__experimental_cache
                        ? {
                            maxAge: req.body.maxAge ?? 4 * 60 * 60 * 1000, // 4 hours
                          }
                        : {}),
                    },
                    internalOptions: {
                      teamId: req.auth.team_id,
                      saveScrapeResultToGCS: process.env
                        .GCS_FIRE_ENGINE_BUCKET_NAME
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
                    zeroDataRetention,
                    apiKeyId: req.acuc?.api_key_id ?? null,
                    concurrencyLimited: limited,
                  },
                };

                const result = await processJobInternal(job);

                setSpanAttributes(waitSpan, {
                  "wait.success": true,
                });

                return result ?? null;
              },
            );

            return doc;
          },
        );
      } catch (e) {
        const timeoutErr =
          e instanceof TransportableError && e.code === "SCRAPE_TIMEOUT";

        if (!timeoutErr) {
          logger.error(`Error in scrapeController`, {
            version: "v2",
            error: e,
          });
        }

        setSpanAttributes(span, {
          "scrape.error": e instanceof Error ? e.message : String(e),
          "scrape.error_type":
            e instanceof TransportableError ? e.code : "unknown",
        });

        if (e instanceof TransportableError) {
          // DNS resolution errors should return 200 with success: false
          if (e.code === "SCRAPE_DNS_RESOLUTION_ERROR") {
            setSpanAttributes(span, {
              "scrape.status_code": 200,
            });
            return res.status(200).json({
              success: false,
              code: e.code,
              error: e.message,
            });
          }

          if (e.code === "SCRAPE_NO_CACHED_DATA") {
            setSpanAttributes(span, {
              "scrape.status_code": 404,
            });
            return res.status(404).json({
              success: false,
              code: e.code,
              error: e.message,
            });
          }

          const statusCode = e.code === "SCRAPE_TIMEOUT" ? 408 : 500;
          setSpanAttributes(span, {
            "scrape.status_code": statusCode,
          });
          return res.status(statusCode).json({
            success: false,
            code: e.code,
            error: e.message,
          });
        } else {
          setSpanAttributes(span, {
            "scrape.status_code": 500,
          });
          return res.status(500).json({
            success: false,
            error: `(Internal server error) - ${e && e.message ? e.message : e}`,
          });
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      if (!hasFormatOfType(req.body.formats, "rawHtml")) {
        if (doc && doc.rawHtml) {
          delete doc.rawHtml;
        }
      }

      const totalRequestTime = new Date().getTime() - middlewareStartTime;
      const controllerTime = new Date().getTime() - controllerStartTime;

      // Set final span attributes
      setSpanAttributes(span, {
        "scrape.success": true,
        "scrape.status_code": 200,
        "scrape.total_request_time_ms": totalRequestTime,
        "scrape.controller_time_ms": controllerTime,
        "scrape.total_wait_time_ms": totalWait,
        "scrape.document.status_code": doc?.metadata?.statusCode,
        "scrape.document.content_type": doc?.metadata?.contentType,
        "scrape.document.error": doc?.metadata?.error,
      });

      let usedLlm =
        !!hasFormatOfType(req.body.formats, "json") ||
        !!hasFormatOfType(req.body.formats, "summary") ||
        !!hasFormatOfType(req.body.formats, "branding");

      if (!usedLlm) {
        const ct = hasFormatOfType(req.body.formats, "changeTracking");

        if (ct && ct.modes?.includes("json")) {
          usedLlm = true;
        }
      }

      const formats: string[] =
        req.body.formats?.map((f: FormatObject) => f?.type) ?? [];

      logger.info("Request metrics", {
        version: "v2",
        scrapeId: jobId,
        mode: "scrape",
        middlewareStartTime,
        controllerStartTime,
        middlewareTime,
        controllerTime,
        totalRequestTime,
        totalWait,
        usedLlm,
        formats,
        concurrencyLimited,
        concurrencyQueueDurationMs: lockTime || undefined,
      });

      return res.status(200).json({
        success: true,
        data: {
          ...doc!,
          metadata: {
            ...doc!.metadata,
            concurrencyLimited,
            concurrencyQueueDurationMs: concurrencyLimited
              ? lockTime || 0
              : undefined,
          },
        },
        scrape_id: origin?.includes("website") ? jobId : undefined,
      });
    },
    {
      attributes: {
        "http.method": "POST",
        "http.route": "/v2/scrape",
      },
      kind: SpanKind.SERVER,
    },
  );
}
