import { NextFunction, Request, Response } from "express";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  Document,
  FormatObject,
  ParseRequest,
  RequestWithAuth,
  ScrapeResponse,
  UploadedParseFile,
  UploadedParseFileKind,
  parseRequestSchema,
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
import { getErrorContactMessage } from "../../lib/deployment";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import type { BillingMetadata } from "../../services/billing/types";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  adjustKeylessCredits,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
import { projectScrapeCredits } from "../../lib/keyless-credit-projection";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
import path from "node:path";

const AGENT_INTEROP_CONCURRENCY_BOOST = 3;
const SUPPORTED_PARSE_FILE_TYPES =
  ".html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls";

const DOCUMENT_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".xlsx",
  ".xls",
]);

export function detectUploadedFileKind(
  filename: string,
  contentType?: string | null,
): UploadedParseFileKind | null {
  const extension = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";

  const isPdf =
    extension === ".pdf" ||
    normalizedType === "application/pdf" ||
    normalizedType.startsWith("application/pdf;");

  if (isPdf) {
    return "pdf";
  }

  const isDocument =
    DOCUMENT_EXTENSIONS.has(extension) ||
    normalizedType.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) ||
    normalizedType.includes("application/vnd.ms-excel") ||
    normalizedType.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ) ||
    normalizedType.includes("application/msword") ||
    normalizedType.includes("application/vnd.oasis.opendocument.text") ||
    normalizedType.includes("application/rtf") ||
    normalizedType.includes("text/rtf");

  if (isDocument) {
    return "document";
  }

  const isHtml =
    extension === ".html" ||
    extension === ".htm" ||
    extension === ".xhtml" ||
    normalizedType.includes("text/html") ||
    normalizedType.includes("application/xhtml+xml");

  if (isHtml) {
    return "html";
  }

  return null;
}

function getSyntheticFilename(file: UploadedParseFile): string {
  const ext = path.extname(file.filename);
  if (ext.length > 0) {
    return file.filename;
  }

  if (file.kind === "pdf") {
    return `${file.filename}.pdf`;
  }

  if (file.kind === "document") {
    return `${file.filename}.docx`;
  }

  return `${file.filename}.html`;
}

function getParseForceEngine(
  kind: UploadedParseFileKind,
): "fetch" | "pdf" | "document" {
  if (kind === "pdf") {
    return "pdf";
  }

  if (kind === "document") {
    return "document";
  }

  return "fetch";
}

function sanitizeParseRequestForLogs(
  body: ParseRequest | Record<string, unknown>,
): Record<string, unknown> {
  const file =
    typeof body === "object" && body !== null && "file" in body
      ? (body as any).file
      : null;

  if (!file || typeof file !== "object") {
    return body as Record<string, unknown>;
  }

  return {
    ...body,
    file: {
      filename: file.filename,
      contentType: file.contentType,
      kind: file.kind,
      size: Buffer.isBuffer(file.buffer) ? file.buffer.length : undefined,
    },
  };
}

function getUnsupportedParseOptionError(reqBody: ParseRequest): string | null {
  if (reqBody.actions !== undefined && reqBody.actions.length > 0) {
    return "Parse uploads do not support actions.";
  }

  if (hasFormatOfType(reqBody.formats, "screenshot")) {
    return "Parse uploads do not support screenshot output.";
  }

  if (hasFormatOfType(reqBody.formats, "branding")) {
    return "Parse uploads do not support branding output.";
  }

  if (hasFormatOfType(reqBody.formats, "changeTracking")) {
    return "Parse uploads do not support change tracking.";
  }

  if (reqBody.waitFor !== undefined && reqBody.waitFor > 0) {
    return "Parse uploads do not support waitFor.";
  }

  if (reqBody.location !== undefined) {
    return "Parse uploads do not support location overrides.";
  }

  if (reqBody.mobile) {
    return "Parse uploads do not support mobile rendering.";
  }

  if (reqBody.proxy && reqBody.proxy !== "auto" && reqBody.proxy !== "basic") {
    return "Parse uploads only support proxy values of auto or basic.";
  }

  return null;
}

export function parseMultipartPayloadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error:
        "Missing file upload. Send multipart/form-data with a 'file' field and optional 'options' JSON string.",
    });
    return;
  }

  let optionsPayload: Record<string, unknown> = {};
  const rawOptions = req.body?.options;

  if (rawOptions !== undefined) {
    if (typeof rawOptions !== "string") {
      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: "The 'options' field must be a JSON string.",
      });
      return;
    }

    try {
      const parsed = JSON.parse(rawOptions);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.status(400).json({
          success: false,
          code: "BAD_REQUEST",
          error: "The 'options' field must parse to a JSON object.",
        });
        return;
      }
      optionsPayload = parsed as Record<string, unknown>;
    } catch (error) {
      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error:
          "Invalid JSON in the 'options' field. Provide a valid JSON string.",
      });
      return;
    }
  }

  const kind = detectUploadedFileKind(file.originalname || "", file.mimetype);
  if (!kind) {
    res.status(400).json({
      success: false,
      code: "UNSUPPORTED_FILE_TYPE",
      error: `Unsupported upload type. Supported file extensions: ${SUPPORTED_PARSE_FILE_TYPES}`,
    });
    return;
  }

  req.body = {
    ...optionsPayload,
    file: {
      buffer: file.buffer,
      filename: file.originalname || "upload",
      contentType: file.mimetype || undefined,
      kind,
    } satisfies UploadedParseFile,
  };

  next();
}

export async function parseController(
  req: RequestWithAuth<{}, ScrapeResponse, ParseRequest>,
  res: Response<ScrapeResponse>,
) {
  return withSpan(
    "api.parse.request",
    async span => {
      const middlewareStartTime =
        (req as any).requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();

      const jobId = uuidv7();
      const preNormalizedBody = sanitizeParseRequestForLogs(req.body);

      setSpanAttributes(span, {
        "parse.job_id": jobId,
        "parse.file_name":
          typeof req.body?.file?.filename === "string"
            ? req.body.file.filename
            : "unknown",
        "parse.team_id": req.auth.team_id,
        "parse.api_key_id": req.acuc?.api_key_id,
        "parse.middleware_time_ms": controllerStartTime - middlewareStartTime,
      });

      await withSpan("api.parse.validate", async validateSpan => {
        req.body = parseRequestSchema.parse(req.body);
        setSpanAttributes(validateSpan, {
          "validation.success": true,
        });
      });

      const unsupportedOptionError = getUnsupportedParseOptionError(req.body);
      if (unsupportedOptionError) {
        setSpanAttributes(span, {
          "parse.status_code": 400,
          "parse.error": unsupportedOptionError,
        });
        return res.status(400).json({
          success: false,
          code: "PARSE_UNSUPPORTED_OPTIONS",
          error: unsupportedOptionError,
        });
      }

      const permissions = await withSpan(
        "api.parse.check_permissions",
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
          "parse.error": permissions.error,
          "parse.status_code": 403,
        });
        return res.status(403).json({
          success: false,
          error: permissions.error,
        });
      }

      const zeroDataRetention =
        getScrapeZDR(req.acuc?.flags) === "forced" ||
        (req.body.zeroDataRetention ?? false);
      const billing: BillingMetadata = req.body.__agentInterop
        ? { endpoint: "agent" as const, jobId }
        : { endpoint: "parse" as const, jobId };

      if (
        req.body.__agentInterop &&
        config.AGENT_INTEROP_SECRET &&
        req.body.__agentInterop.auth !== config.AGENT_INTEROP_SECRET
      ) {
        return res.status(403).json({
          success: false,
          error: "Invalid agent interop.",
        });
      } else if (req.body.__agentInterop && !config.AGENT_INTEROP_SECRET) {
        return res.status(403).json({
          success: false,
          error: "Agent interop is not enabled.",
        });
      }

      const shouldBill = req.body.__agentInterop?.shouldBill ?? true;
      const agentRequestId = req.body.__agentInterop?.requestId ?? null;
      const boostConcurrency =
        req.body.__agentInterop?.boostConcurrency ?? false;
      const isDirectToBullMQ =
        config.SEARCH_PREVIEW_TOKEN !== undefined &&
        config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;
      const projectedKeylessCredits =
        shouldBill && !isDirectToBullMQ
          ? projectScrapeCredits(
              req.body,
              req.acuc?.flags ?? null,
              zeroDataRetention,
            )
          : 0;
      let reservedKeylessCredits = 0;
      let reconciledKeylessCredits = false;

      if (projectedKeylessCredits > 0) {
        const reservation = await reserveKeylessCredits(
          req.auth.team_id,
          projectedKeylessCredits,
        );
        if (!reservation.ok) {
          applyAgentAuthDiscoveryHeader(res);
          return res.status(429).json({
            success: false,
            error: KEYLESS_FREE_TIER_LIMIT_MESSAGE,
          });
        }
        reservedKeylessCredits = projectedKeylessCredits;
      }

      const logger = _logger.child({
        method: "parseController",
        jobId,
        noq: true,
        scrapeId: jobId,
        teamId: req.auth.team_id,
        team_id: req.auth.team_id,
        zeroDataRetention,
      });

      const middlewareTime = controllerStartTime - middlewareStartTime;
      logger.debug("Parse " + jobId + " starting", {
        version: "v2",
        parseId: jobId,
        request: sanitizeParseRequestForLogs(req.body),
        originalRequest: preNormalizedBody,
        account: req.account,
      });

      if (!agentRequestId) {
        logRequest({
          id: jobId,
          kind: "parse",
          api_version: "v2",
          team_id: req.auth.team_id,
          origin: req.body.origin ?? "api",
          integration: req.body.integration,
          target_hint: req.body.file.filename,
          zeroDataRetention: zeroDataRetention || false,
          api_key_id: req.acuc?.api_key_id ?? null,
        }).catch(err =>
          logger.warn("Background request log failed", { error: err, jobId }),
        );
      }

      setSpanAttributes(span, {
        "parse.zero_data_retention": zeroDataRetention,
        "parse.origin": req.body.origin,
        "parse.timeout": req.body.timeout,
        "parse.file_kind": req.body.file.kind,
      });

      const origin = req.body.origin;
      const timeout = req.body.timeout;

      const totalWait = 0;

      let lockTime: number | null = null;
      let concurrencyLimited = false;

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

        const baseConcurrency = req.acuc?.concurrency || 1;
        const concurrency = boostConcurrency
          ? baseConcurrency * AGENT_INTEROP_CONCURRENCY_BOOST
          : baseConcurrency;

        doc = await teamConcurrencySemaphore.withSemaphore(
          req.auth.team_id,
          jobId,
          concurrency,
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

            const { file, ...parseOptions } = req.body;
            const syntheticFilename = getSyntheticFilename(file);
            const syntheticUrl = `https://parse.firecrawl.dev/uploads/${encodeURIComponent(syntheticFilename)}`;
            const forceEngine = getParseForceEngine(file.kind!);

            const doc = await withSpan(
              "api.parse.wait_for_job",
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
                    url: syntheticUrl,
                    mode: "single_urls",
                    team_id: req.auth.team_id,
                    scrapeOptions: {
                      ...parseOptions,
                      maxAge: 0,
                      storeInCache: false,
                    },
                    internalOptions: {
                      teamId: req.auth.team_id,
                      saveScrapeResultToGCS: process.env
                        .GCS_FIRE_ENGINE_BUCKET_NAME
                        ? true
                        : false,
                      unnormalizedSourceURL: file.filename,
                      bypassBilling: isDirectToBullMQ || !shouldBill,
                      zeroDataRetention,
                      teamFlags: req.acuc?.flags ?? null,
                      teamConcurrency: req.acuc?.concurrency ?? null,
                      uploadedFile: file,
                      forceEngine,
                      isParse: true,
                      agentIndexOnly: (req as any).agentIndexOnly ?? false,
                    },
                    skipNuq: true,
                    origin,
                    integration: req.body.integration,
                    billing,
                    startTime: controllerStartTime,
                    zeroDataRetention,
                    apiKeyId: req.acuc?.api_key_id ?? null,
                    concurrencyLimited: limited,
                    keylessReserved: reservedKeylessCredits > 0,
                    requestId: agentRequestId ?? undefined,
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
        if (reservedKeylessCredits > 0 && !reconciledKeylessCredits) {
          reconciledKeylessCredits = true;
          adjustKeylessCredits(req.auth.team_id, -reservedKeylessCredits).catch(
            () => {},
          );
        }

        const timeoutErr =
          e instanceof TransportableError && e.code === "SCRAPE_TIMEOUT";

        setSpanAttributes(span, {
          "parse.error": e instanceof Error ? e.message : String(e),
          "parse.error_type":
            e instanceof TransportableError ? e.code : "unknown",
        });

        if (e instanceof TransportableError) {
          if (!timeoutErr) {
            logger.error("Error in parseController", {
              version: "v2",
              error: e,
            });
          }

          if (e.code === "SCRAPE_NO_CACHED_DATA") {
            setSpanAttributes(span, {
              "parse.status_code": 404,
            });
            return res.status(404).json({
              success: false,
              code: e.code,
              error: e.message,
            });
          }

          if (e.code === "AGENT_INDEX_ONLY") {
            setSpanAttributes(span, {
              "parse.status_code": 403,
            });
            return res.status(403).json({
              success: false,
              code: e.code,
              error: e.message,
              sponsor_status: "pending",
              login_url: "https://firecrawl.dev/signin",
            });
          }

          if (e.code === "SCRAPE_ACTIONS_NOT_SUPPORTED") {
            setSpanAttributes(span, {
              "parse.status_code": 400,
            });
            return res.status(400).json({
              success: false,
              code: e.code,
              error: e.message,
            });
          }

          const statusCode = e.code === "SCRAPE_TIMEOUT" ? 408 : 500;
          setSpanAttributes(span, {
            "parse.status_code": statusCode,
          });
          return res.status(statusCode).json({
            success: false,
            code: e.code,
            error: e.message,
          });
        } else {
          const id = uuidv7();
          logger.error("Error in parseController", {
            version: "v2",
            error: e,
            errorId: id,
            path: req.path,
            teamId: req.auth.team_id,
          });
          captureExceptionWithZdrCheck(e, {
            tags: {
              errorId: id,
              version: "v2",
              teamId: req.auth.team_id,
            },
            extra: {
              path: req.path,
              fileName: req.body.file.filename,
            },
            zeroDataRetention,
          });
          setSpanAttributes(span, {
            "parse.status_code": 500,
            "parse.error_id": id,
          });
          return res.status(500).json({
            success: false,
            code: "UNKNOWN_ERROR",
            error: getErrorContactMessage(id),
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

      if (reservedKeylessCredits > 0 && !reconciledKeylessCredits) {
        reconciledKeylessCredits = true;
        const actualKeylessCredits = doc?.metadata?.creditsUsed ?? 0;
        adjustKeylessCredits(
          req.auth.team_id,
          actualKeylessCredits - reservedKeylessCredits,
        ).catch(() => {});
        logKeylessCreditUsage(req.auth.team_id, actualKeylessCredits).catch(
          () => {},
        );
      }

      const totalRequestTime = new Date().getTime() - middlewareStartTime;
      const controllerTime = new Date().getTime() - controllerStartTime;

      setSpanAttributes(span, {
        "parse.success": true,
        "parse.status_code": 200,
        "parse.total_request_time_ms": totalRequestTime,
        "parse.controller_time_ms": controllerTime,
        "parse.total_wait_time_ms": totalWait,
        "parse.document.status_code": doc?.metadata?.statusCode,
        "parse.document.content_type": doc?.metadata?.contentType,
        "parse.document.error": doc?.metadata?.error,
      });

      let usedLlm =
        !!hasFormatOfType(req.body.formats, "json") ||
        !!hasFormatOfType(req.body.formats, "summary") ||
        !!hasFormatOfType(req.body.formats, "question") ||
        !!hasFormatOfType(req.body.formats, "highlights") ||
        !!hasFormatOfType(req.body.formats, "query");

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
        parseId: jobId,
        mode: "parse",
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
      });
    },
    {
      attributes: {
        "http.method": "POST",
        "http.route": "/v2/parse",
      },
      kind: SpanKind.SERVER,
    },
  );
}
