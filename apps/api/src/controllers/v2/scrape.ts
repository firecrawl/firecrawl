import { Response } from "express";
import { logger as _logger } from "../../lib/logger";
import {
  Document,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { getJobPriority } from "../../lib/job-priority";
import { hasFormatOfType } from "../../lib/format-utils";
import { TransportableError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
import { checkPermissions } from "../../lib/permissions";
import { withSpan, setSpanAttributes, SpanKind } from "../../lib/otel-tracer";
import { cancelScrapeJob } from "../../services/job-cancellation";

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

      const jobId = uuidv4();
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
        req.acuc?.flags?.forceZDR || req.body.zeroDataRetention;

      const logger = _logger.child({
        method: "scrapeController",
        jobId,
        scrapeId: jobId,
        teamId: req.auth.team_id,
        team_id: req.auth.team_id,
        zeroDataRetention,
      });

      const middlewareTime = controllerStartTime - middlewareStartTime;

      let responseSent = false;
      let clientDisconnected = false;

      const cleanupConnectionHandlers = () => {
        if (typeof req.off === "function") {
          req.off("close", handleDisconnect);
          req.off("aborted", handleDisconnect);
        } else {
          req.removeListener("close", handleDisconnect);
          req.removeListener("aborted", handleDisconnect);
        }
      };

      const handleDisconnect = () => {
        if (responseSent || clientDisconnected) {
          return;
        }
        clientDisconnected = true;
        logger.warn("Client disconnected; cancelling scrape job", {
          jobId,
        });
        cancelScrapeJob({
          jobId,
          teamId: req.auth.team_id,
          reason: "client_disconnect",
          logger,
        }).catch(error => {
          logger.warn("Failed to cancel job after disconnect", {
            error,
            jobId,
          });
        });
      };

      req.on("close", handleDisconnect);
      req.on("aborted", handleDisconnect);

      try {
        logger.debug("Scrape " + jobId + " starting", {
          version: "v2",
          scrapeId: jobId,
          request: req.body,
          originalRequest: preNormalizedBody,
          account: req.account,
        });

        setSpanAttributes(span, {
          "scrape.zero_data_retention": zeroDataRetention,
          "scrape.origin": req.body.origin,
          "scrape.timeout": req.body.timeout,
        });

        const origin = req.body.origin;
        const timeout = req.body.timeout;

        const isDirectToBullMQ =
          process.env.SEARCH_PREVIEW_TOKEN !== undefined &&
          process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

        const jobPriority = await getJobPriority({
          team_id: req.auth.team_id,
          basePriority: 10,
        });

        // Job enqueuing span
        const job = await withSpan(
          "api.scrape.enqueue_job",
          async enqueueSpan => {
            const result = await addScrapeJob(
              {
                url: req.body.url,
                mode: "single_urls",
                team_id: req.auth.team_id,
                scrapeOptions: {
                  ...req.body,
                  ...(req.body.__experimental_cache
                    ? {
                        maxAge: req.body.maxAge ?? 4 * 60 * 60 * 1000, // 4 hours
                      }
                    : {}),
                },
                internalOptions: {
                  teamId: req.auth.team_id,
                  saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
                    ? true
                    : false,
                  unnormalizedSourceURL: preNormalizedBody.url,
                  bypassBilling: isDirectToBullMQ,
                  zeroDataRetention,
                  teamFlags: req.acuc?.flags ?? null,
                },
                origin,
                integration: req.body.integration,
                startTime: controllerStartTime,
                zeroDataRetention,
                apiKeyId: req.acuc?.api_key_id ?? null,
              },
              jobId,
              jobPriority,
              isDirectToBullMQ,
              true,
            );

            setSpanAttributes(enqueueSpan, {
              "job.priority": jobPriority,
              "job.direct_to_bullmq": isDirectToBullMQ,
            });

            return result;
          },
        );

        const totalWait =
          (req.body.waitFor ?? 0) +
          (req.body.actions ?? []).reduce(
            (a, x) => (x.type === "wait" ? (x.milliseconds ?? 0) : 0) + a,
            0,
          );

        let doc: Document;
        try {
          doc = await withSpan("api.scrape.wait_for_job", async waitSpan => {
            setSpanAttributes(waitSpan, {
              "wait.timeout":
                timeout !== undefined ? timeout + totalWait : null,
              "wait.job_id": jobId,
            });

            const result = await waitForJob(
              job ?? jobId,
              timeout !== undefined ? timeout + totalWait : null,
              zeroDataRetention,
              logger,
            );

            setSpanAttributes(waitSpan, {
              "wait.success": true,
            });

            return result;
          });
        } catch (e) {
          logger.error(`Error in scrapeController`, {
            version: "v2",
            error: e,
          });

          if (clientDisconnected) {
            return;
          }

          setSpanAttributes(span, {
            "scrape.error": e instanceof Error ? e.message : String(e),
            "scrape.error_type":
              e instanceof TransportableError ? e.code : "unknown",
          });

          if (zeroDataRetention) {
            await scrapeQueue.removeJob(jobId, logger);
          }

          if (e instanceof TransportableError) {
            const statusCode =
              e.code === "SCRAPE_TIMEOUT"
                ? 408
                : e.code === "SCRAPE_JOB_CANCELLED"
                  ? 499
                  : 500;
            setSpanAttributes(span, {
              "scrape.status_code": statusCode,
            });
            responseSent = true;
            return res.status(statusCode).json({
              success: false,
              code: e.code,
              error: e.message,
            });
          } else {
            setSpanAttributes(span, {
              "scrape.status_code": 500,
            });
            responseSent = true;
            return res.status(500).json({
              success: false,
              error: `(Internal server error) - ${e && e.message ? e.message : e}`,
            });
          }
        }

        if (clientDisconnected) {
          return;
        }

        await scrapeQueue.removeJob(jobId, logger);

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
          "scrape.document.status_code": doc?.metadata?.statusCode,
          "scrape.document.content_type": doc?.metadata?.contentType,
          "scrape.document.error": doc?.metadata?.error,
        });

        logger.info("Request metrics", {
          version: "v2",
          scrapeId: jobId,
          mode: "scrape",
          middlewareStartTime,
          controllerStartTime,
          middlewareTime,
          controllerTime,
          totalRequestTime,
        });

        responseSent = true;
        return res.status(200).json({
          success: true,
          data: doc,
          scrape_id: origin?.includes("website") ? jobId : undefined,
        });
      } finally {
        cleanupConnectionHandlers();
      }
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
