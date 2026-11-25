import { Response } from "express";

import { logger as _logger } from "../../lib/logger";
import {
  Document,
  FormatObject,
  getV2RequestSchemas,
  RequestWithAuth,
  ScrapeRequest,
  ScrapeResponse,
} from "./types";
import { v7 as uuidv7 } from "uuid";
import { hasFormatOfType } from "../../lib/format-utils";
import {
  getErrorHttpResponse,
  getTimeoutProcessingDetails,
  isTransportableError,
  TransportableError,
} from "../../lib/error";
import { NuQJob } from "../../services/worker/nuq";
import { withSpan, setSpanAttributes, SpanKind } from "../../lib/otel-tracer";
import { processJobInternal } from "../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../types";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import { currentLimits, resolveJobPriority } from "../../lib/limits";
import {
  contextThreatProtection,
  requestContext,
} from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import {
  finalizeResponse,
  service,
  type RequestContext,
  type SettleOutcome,
} from "../../service";
import type { BillingMetadata } from "../../lib/billing-types";

const AGENT_INTEROP_CONCURRENCY_BOOST = 3;

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>,
) {
  const rawBody = req.body as Record<string, any> | undefined;
  const zeroDataRetentionTrace =
    req.ctx?.zeroDataRetention === true ||
    req.body?.zeroDataRetention === true ||
    rawBody?.lockdown === true;

  return withSpan(
    "api.scrape.request",
    async span => {
      // Get timing data from middleware (includes all middleware processing time)
      const middlewareStartTime =
        (req as any).requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();

      const jobId = req.requestId ?? uuidv7();
      const preNormalizedBody = (req.rawRequestBody as
        | Partial<ScrapeRequest>
        | undefined) ?? {
        ...req.body,
      };

      // Set initial span attributes
      setSpanAttributes(span, {
        "scrape.job_id": jobId,
        "scrape.url": req.body.url,
        "scrape.team_id": req.auth.team_id,
        "scrape.api_key_id": req.acuc?.api_key_id,
        "scrape.middleware_time_ms": controllerStartTime - middlewareStartTime,
      });

      if (!req.ctx) {
        await withSpan("api.scrape.validate", async validateSpan => {
          req.body = getV2RequestSchemas().scrape.parse(req.body);
          setSpanAttributes(validateSpan, {
            "validation.success": true,
          });
        });
      }
      const extBody = req.body as Record<string, any>;

      const zeroDataRetention =
        req.ctx?.zeroDataRetention ??
        ((req.body.zeroDataRetention ?? false) || (extBody.lockdown ?? false));
      const billing: BillingMetadata = req.ctx?.billing ?? {
        ...(extBody.__agentInterop
          ? { endpoint: "agent" as const, jobId }
          : { endpoint: "scrape" as const, jobId }),
        hostedMcp: req.auth.hostedMcp,
      };
      const ctx: RequestContext = req.ctx
        ? req.ctx.billing
          ? req.ctx
          : { ...req.ctx, billing }
        : requestContext({
            teamId: req.auth.team_id,
            zeroDataRetention,
            flags: req.acuc?.flags ?? null,
            orgId: req.acuc?.org_id ?? null,
            apiKeyId: req.acuc?.api_key_id ?? null,
            billing,
            concurrencyLimit: req.acuc?.concurrency_limit,
            rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
          });
      req.ctx = ctx;

      const shouldBill = extBody.__agentInterop?.shouldBill ?? true;
      const agentRequestId = extBody.__agentInterop?.requestId ?? null;
      const boostConcurrency =
        extBody.__agentInterop?.boostConcurrency ?? false;
      const reservation = await service.modules.billing.authorize({
        caller: req.caller ?? { teamId: req.auth.team_id },
        operation: "scrape",
        stage: "reserve",
        ctx,
        state: {
          req,
          shouldBill,
          scrapeOptions: req.body,
          endpoint: "v2_scrape",
        },
      });
      if (!reservation.ok) {
        if (reservation.refusal.headers) {
          for (const [name, value] of Object.entries(
            reservation.refusal.headers,
          )) {
            res.setHeader(name, value);
          }
        }
        return res
          .status(reservation.refusal.status)
          .json(reservation.refusal.body as ScrapeResponse);
      }
      const billingHandle = reservation.handle;
      let settledBilling = false;

      const logger = _logger.child({
        method: "scrapeController",
        jobId,
        noq: true,
        scrapeId: jobId,
        teamId: req.auth.team_id,
        team_id: req.auth.team_id,
        zeroDataRetention,
      });

      const settleBilling = async (outcome: SettleOutcome) => {
        if (billingHandle === undefined || settledBilling) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await service.modules.billing.settle?.(billingHandle, outcome);
            settledBilling = true;
            return;
          } catch (settleError) {
            if (attempt === 1) {
              logger.error("Failed to settle billing reservation", {
                teamId: req.auth.team_id,
                jobId,
                ok: outcome.ok,
                error: settleError,
              });
            }
          }
        }
      };

      const middlewareTime = controllerStartTime - middlewareStartTime;

      logger.debug("Scrape " + jobId + " starting", {
        version: "v2",
        scrapeId: jobId,
        request: req.body,
        originalRequest: preNormalizedBody,
        account: req.account,
      });

      let logRequestPromise: Promise<any> | undefined = undefined;

      if (!agentRequestId) {
        logRequestPromise = service.modules.jobStore
          .register({
            id: jobId,
            kind: "scrape",
            ctx,
            clientOrigin: req.body.origin ?? "api",
          })
          .catch(err =>
            logger.error("Background job registration failed", {
              error: err,
              jobId,
            }),
          );
      }

      setSpanAttributes(span, {
        "scrape.zero_data_retention": zeroDataRetention,
        "scrape.origin": req.body.origin,
        "scrape.timeout": req.body.timeout,
      });

      const origin = req.body.origin;
      const timeout = req.body.timeout;

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

        const baseConcurrency = await currentLimits().concurrency(ctx);
        const concurrency =
          baseConcurrency === null
            ? null
            : boostConcurrency
              ? baseConcurrency * AGENT_INTEROP_CONCURRENCY_BOOST
              : baseConcurrency;

        doc = await teamConcurrencySemaphore.withSemaphore(
          req.auth.team_id,
          jobId,
          concurrency,
          aborter.signal,
          timeout ?? 60_000,
          async limited => {
            const jobPriority = await resolveJobPriority(ctx, 10, error => {
              logger.error("Failed to determine job priority", { error });
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

                const threatProtection = contextThreatProtection(ctx);
                const job: NuQJob<ScrapeJobData> = {
                  id: jobId,

                  status: "active",
                  createdAt: new Date(),
                  priority: jobPriority,
                  data: {
                    url: req.body.url,
                    mode: "single_urls",
                    ctx,
                    team_id: req.auth.team_id,
                    scrapeOptions: {
                      ...req.body,
                      ...((req.body as any).__experimental_cache
                        ? {
                            maxAge: extBody.maxAge ?? 4 * 60 * 60 * 1000, // 4 hours
                          }
                        : {}),
                    },
                    internalOptions: {
                      ctx,
                      teamId: req.auth.team_id,
                      unnormalizedSourceURL: preNormalizedBody.url,
                      bypassBilling:
                        reservation.bypassBilling === true || !shouldBill,
                      zeroDataRetention,
                      ...(req.headers["x-firecrawl-work-contact-only"] ===
                      "true"
                        ? { workContactOnly: true }
                        : {}),
                      teamFlags: req.acuc?.flags ?? null,
                      orgId: req.acuc?.org_id ?? null,
                      teamConcurrency: baseConcurrency,
                      agentIndexOnly: (req as any).agentIndexOnly ?? false,
                      // Rolling-deploy compatibility dual-write alongside the ctx fallback.
                      ...(threatProtection !== undefined
                        ? { threatProtection }
                        : {}),
                    },
                    skipNuq: true,
                    origin,
                    integration: req.body.integration,
                    billing,
                    startTime: controllerStartTime,
                    zeroDataRetention,
                    apiKeyId: req.acuc?.api_key_id ?? null,
                    concurrencyLimited: limited,
                    keylessReserved: billingHandle !== undefined,
                    requestId: agentRequestId ?? undefined,
                    logRequestPromise: logRequestPromise,
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
          ctx,
        );
      } catch (e) {
        void settleBilling({ ok: false });

        const timeoutErr =
          isTransportableError(e) &&
          (e.code === "SCRAPE_TIMEOUT" ||
            e.code === "CONCURRENCY_QUEUE_TIMEOUT");

        setSpanAttributes(span, {
          "scrape.error": e instanceof Error ? e.message : String(e),
          "scrape.error_type": isTransportableError(e) ? e.code : "unknown",
        });

        const jobIdField = agentRequestId ? {} : { jobId };

        if (isTransportableError(e)) {
          if (!timeoutErr) {
            logger.error(`Error in scrapeController`, {
              version: "v2",
              error: e,
            });
          }
          const httpResponse = getErrorHttpResponse(e);
          if (httpResponse) {
            setSpanAttributes(span, {
              "scrape.status_code": httpResponse.status,
            });
            return res.status(httpResponse.status).json({
              ...httpResponse.extraFields,
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          // DNS resolution errors should return 200 with success: false
          if (e.code === "SCRAPE_DNS_RESOLUTION_ERROR") {
            setSpanAttributes(span, {
              "scrape.status_code": 200,
            });
            return res.status(200).json({
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          if (e.code === "SCRAPE_ACTIONS_NOT_SUPPORTED") {
            setSpanAttributes(span, {
              "scrape.status_code": 400,
            });
            return res.status(400).json({
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          if (e.code === "UNSUPPORTED_SITE") {
            setSpanAttributes(span, {
              "scrape.status_code": 403,
            });
            return res.status(403).json({
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          if (e.code === "SCRAPE_PROMPT_INJECTION_DETECTED") {
            setSpanAttributes(span, {
              "scrape.status_code": 403,
            });
            return res.status(403).json({
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          if (e.code === "SCRAPE_JSON_CONTENT_TOO_LARGE") {
            setSpanAttributes(span, {
              "scrape.status_code": 400,
            });
            return res.status(400).json({
              success: false,
              code: e.code,
              error: e.message,
              ...jobIdField,
            });
          }

          const statusCode = timeoutErr ? 408 : 500;
          setSpanAttributes(span, {
            "scrape.status_code": statusCode,
          });
          // Large-PDF timeouts where the fire-pdf job keeps processing
          // server-side carry structured retry guidance: surface it as
          // `details` plus a standard Retry-After header so clients (and
          // retry libraries) know a timed retry returns the finished
          // result instead of restarting the work.
          const processing = getTimeoutProcessingDetails(e);
          if (processing) {
            res.setHeader("Retry-After", String(processing.retryAfterSeconds));
          }
          return res.status(statusCode).json({
            success: false,
            code: e.code,
            error: e.message,
            ...jobIdField,
            ...(processing && { details: processing }),
          });
        } else {
          const id = uuidv7();
          logger.error(`Error in scrapeController`, {
            version: "v2",
            error: e,
            errorId: id,
            path: req.path,
            teamId: req.auth.team_id,
          });
          setSpanAttributes(span, {
            "scrape.status_code": 500,
            "scrape.error_id": id,
          });
          return res.status(500).json({
            success: false,
            code: "UNKNOWN_ERROR",
            error: service.modules.messages.errorContact(id),
            ...jobIdField,
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

      await settleBilling({
        ok: true,
        charged: doc?.metadata?.creditsUsed,
      });

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

      const rawFormats = (req.body.formats ?? []) as Array<{
        type: string;
        modes?: string[];
      }>;
      let usedLlm =
        rawFormats.some(
          f =>
            f.type === "json" ||
            f.type === "summary" ||
            f.type === "branding" ||
            f.type === "question" ||
            f.type === "highlights" ||
            f.type === "query",
        ) || req.body.checkPromptInjection;

      if (!usedLlm) {
        const ct = rawFormats.find(f => f.type === "changeTracking");

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

      const responseDocument: Document = {
        ...doc!,
        metadata: {
          ...doc!.metadata,
          concurrencyLimited,
          concurrencyQueueDurationMs: concurrencyLimited
            ? lockTime || 0
            : undefined,
        },
      };
      const payload = await finalizeResponse(
        req,
        "scrape",
        {
          success: true,
          data: responseDocument,
          scrape_id: origin?.includes("website") ? jobId : undefined,
        },
        [responseDocument],
      );
      return res.status(200).json(payload as ScrapeResponse);
    },
    {
      attributes: {
        "http.method": "POST",
        "http.route": "/v2/scrape",
      },
      kind: SpanKind.SERVER,
      zeroDataRetention: zeroDataRetentionTrace,
    },
  );
}
