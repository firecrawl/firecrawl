import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { logger as _logger } from "../../lib/logger";
import type {
  Document,
  FormatObject,
  ParseRequest,
  RequestWithAuth,
  ScrapeOptions,
  ScrapeResponse,
  UploadedParseFile,
  UploadedParseFileKind,
} from "./types";
import { getV2RequestSchemas } from "./types";
import { v7 as uuidv7 } from "uuid";
import { hasFormatOfType } from "../../lib/format-utils";
import { getErrorHttpResponse, isTransportableError } from "../../lib/error";
import type { NuQJob } from "../../services/worker/nuq";
import { withSpan, setSpanAttributes, SpanKind } from "../../lib/otel-tracer";
import { processJobInternal } from "../../services/worker/scrape-worker";
import type { ScrapeJobData } from "../../types";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import { currentLimits, resolveJobPriority } from "../../lib/limits";
import {
  contextThreatProtection,
  requestContext,
} from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { finalizeResponse, service } from "../../service";
import type {
  RequestContext,
  ResponsePayload,
  SettleOutcome,
} from "../../service";
import type { EngineName } from "../../service/engines";
import { installedService } from "../../service/service";
import type { BillingMetadata } from "../../lib/billing-types";
import { jsonObjectSchema, jsonValueSchema } from "../../lib/json-types";
import type { JsonObject } from "../../lib/json-types";
import { readAgentInterop, readBooleanField } from "./agent-interop";
import type { InternalOptions } from "../../scraper/scrapeURL";
import path from "node:path";
import {
  DOCUMENT_EXTENSIONS,
  documentExtensionFromContentType,
} from "../../lib/document-formats";
import {
  IMAGE_EXTENSIONS,
  imageExtensionFromContentType,
} from "../../lib/image-formats";
import { isImageOcrEnabled } from "../../lib/image-ocr-gate";
import {
  HTML_CONTENT_TYPES,
  HTML_EXTENSIONS,
  listParseFormats,
  PDF_CONTENT_TYPES,
  PDF_EXTENSIONS,
} from "../../lib/parse-formats";

const AGENT_INTEROP_CONCURRENCY_BOOST = 3;

/** Image uploads are OCR'd through FirePDF, so they are only advertised as
 * supported for teams with image OCR enabled (matching
 * detectUploadedFileKind). */
export function getSupportedParseFileTypes(imageOcrEnabled: boolean): string {
  return listParseFormats(imageOcrEnabled)
    .filter(format => format.available)
    .flatMap(format => format.extensions)
    .join(", ");
}

export function detectUploadedFileKind(
  filename: string,
  contentType?: string | null,
  imageOcrEnabled = false,
): UploadedParseFileKind | null {
  const extension = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";

  const isPdf =
    PDF_EXTENSIONS.includes(extension) ||
    PDF_CONTENT_TYPES.some(
      type => normalizedType === type || normalizedType.startsWith(`${type};`),
    );

  if (isPdf) {
    return "pdf";
  }

  const isDocument =
    DOCUMENT_EXTENSIONS.has(extension) ||
    documentExtensionFromContentType(normalizedType) !== null;

  if (isDocument) {
    return "document";
  }

  // Image uploads are OCR'd through FirePDF where the deployment has image
  // OCR on (lib/image-ocr-gate.ts); otherwise they stay unsupported.
  const isImage =
    imageOcrEnabled &&
    (IMAGE_EXTENSIONS.has(extension) ||
      imageExtensionFromContentType(normalizedType) !== null);

  if (isImage) {
    return "image";
  }

  const isHtml =
    HTML_EXTENSIONS.includes(extension) ||
    HTML_CONTENT_TYPES.some(type => normalizedType.includes(type));

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

  if (file.kind === "image") {
    return `${file.filename}${imageExtensionFromContentType(file.contentType) ?? ".png"}`;
  }

  return `${file.filename}.html`;
}

function getParseForceEngine(
  kind: UploadedParseFileKind,
): EngineName | undefined {
  if (kind === "pdf") {
    return "pdf";
  }

  if (kind === "document") {
    return "document";
  }

  if (kind === "image") {
    return installedService()
      ?.engines.all()
      .find(
        engine =>
          engine.features.image === true && !engine.cache && engine.enabled(),
      )?.name;
  }

  return "fetch";
}

function softOptional<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const uploadedFileLogSchema = z.object({
  filename: softOptional(z.string()),
  contentType: softOptional(z.string()),
  kind: softOptional(z.string()),
  buffer: softOptional(z.custom<Buffer>(value => Buffer.isBuffer(value))),
});

const parseRequestLogSchema = z
  .object({
    file: softOptional(uploadedFileLogSchema),
  })
  .catchall(softOptional(jsonValueSchema));

const multipartOptionsFieldSchema = z.object({
  options: z.unknown().optional(),
});

function sanitizeParseRequestForLogs(body: unknown): JsonObject {
  const parsed = parseRequestLogSchema.safeParse(body);
  if (!parsed.success) {
    return {};
  }
  const { file, ...rest } = parsed.data;
  if (!file) {
    return rest;
  }
  const sanitizedFile: JsonObject = {
    filename: file.filename,
    contentType: file.contentType,
    kind: file.kind,
    size: file.buffer?.length,
  };
  return {
    ...rest,
    file: sanitizedFile,
  };
}

function getUnsupportedParseOptionError(reqBody: ParseRequest): string | null {
  if (reqBody.actions !== undefined && reqBody.actions.length > 0) {
    return "Parse uploads do not support actions.";
  }

  if (hasFormatOfType(reqBody.formats, "screenshot")) {
    return "Parse uploads do not support screenshot output.";
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

  let optionsPayload: JsonObject = {};
  const parsedBody = multipartOptionsFieldSchema.safeParse(req.body);
  const rawOptions = parsedBody.success ? parsedBody.data.options : undefined;

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
      const parsedOptions = jsonObjectSchema.safeParse(JSON.parse(rawOptions));
      if (!parsedOptions.success) {
        res.status(400).json({
          success: false,
          code: "BAD_REQUEST",
          error: "The 'options' field must parse to a JSON object.",
        });
        return;
      }
      optionsPayload = parsedOptions.data;
    } catch {
      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error:
          "Invalid JSON in the 'options' field. Provide a valid JSON string.",
      });
      return;
    }
  }

  const imageOcrEnabled = isImageOcrEnabled();
  const kind = detectUploadedFileKind(
    file.originalname || "",
    file.mimetype,
    imageOcrEnabled,
  );
  if (!kind) {
    res.status(400).json({
      success: false,
      code: "UNSUPPORTED_FILE_TYPE",
      error: `Unsupported upload type. Supported file extensions: ${getSupportedParseFileTypes(imageOcrEnabled)}`,
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
  req: RequestWithAuth<Request["params"], ScrapeResponse, ParseRequest>,
  res: Response<ScrapeResponse | ResponsePayload>,
) {
  const zeroDataRetentionTrace =
    req.ctx?.zeroDataRetention === true || req.body?.zeroDataRetention === true;

  return withSpan(
    "api.parse.request",
    async span => {
      const middlewareStartTime =
        req.requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();

      const jobId = req.requestId ?? uuidv7();
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

      if (!req.ctx) {
        await withSpan("api.parse.validate", async validateSpan => {
          req.body = getV2RequestSchemas().parse.parse(req.body);
          setSpanAttributes(validateSpan, {
            "validation.success": true,
          });
        });
      }

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

      const forceEngine = req.body.file.kind
        ? getParseForceEngine(req.body.file.kind)
        : undefined;
      if (!forceEngine) {
        const unsupportedFileError = `Unsupported upload type. Supported file extensions: ${getSupportedParseFileTypes(false)}`;
        setSpanAttributes(span, {
          "parse.status_code": 400,
          "parse.error": unsupportedFileError,
        });
        return res.status(400).json({
          success: false,
          code: "UNSUPPORTED_FILE_TYPE",
          error: unsupportedFileError,
        });
      }

      const agentInterop = readAgentInterop(req.body);
      const zeroDataRetention =
        req.ctx?.zeroDataRetention ?? req.body.zeroDataRetention ?? false;
      const billing: BillingMetadata = req.ctx?.billing ?? {
        ...(agentInterop
          ? { endpoint: "agent" as const, jobId }
          : { endpoint: "parse" as const, jobId }),
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

      const shouldBill = agentInterop?.shouldBill ?? true;
      const agentRequestId = agentInterop?.requestId ?? null;
      const boostConcurrency = agentInterop?.boostConcurrency ?? false;
      const reservation = await service.modules.billing.authorize({
        caller: req.caller ?? { teamId: req.auth.team_id },
        operation: "parse",
        stage: "reserve",
        ctx,
        state: {
          req,
          shouldBill,
          scrapeOptions: req.body,
          endpoint: "v2_parse",
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
          .json(reservation.refusal.body);
      }
      const billingHandle = reservation.handle;
      let settledBilling = false;

      const logger = _logger.child({
        method: "parseController",
        jobId,
        noq: true,
        scrapeId: jobId,
        teamId: req.auth.team_id,
        team_id: req.auth.team_id,
        zeroDataRetention,
      });

      const settleBilling = async (outcome: SettleOutcome) => {
        if (billingHandle === undefined || settledBilling) {
          return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await service.modules.billing.settle?.(billingHandle, outcome);
            settledBilling = true;
            return;
          } catch (settleError: unknown) {
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
      logger.debug("Parse " + jobId + " starting", {
        version: "v2",
        parseId: jobId,
        request: sanitizeParseRequestForLogs(req.body),
        originalRequest: preNormalizedBody,
        account: req.account,
      });

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

            const { file, ...parseOptions } = req.body;
            const syntheticFilename = getSyntheticFilename(file);
            const syntheticUrl = `https://parse.firecrawl.dev/uploads/${encodeURIComponent(syntheticFilename)}`;

            const doc = await withSpan(
              "api.parse.wait_for_job",
              async waitSpan => {
                setSpanAttributes(waitSpan, {
                  "wait.timeout":
                    timeout !== undefined ? timeout + totalWait : undefined,
                  "wait.job_id": jobId,
                });

                const threatProtection = contextThreatProtection(ctx);
                const internalOptions: InternalOptions = {
                  ctx,
                  teamId: req.auth.team_id,
                  unnormalizedSourceURL: file.filename,
                  bypassBilling:
                    reservation.bypassBilling === true || !shouldBill,
                  zeroDataRetention,
                  teamFlags: req.acuc?.flags ?? null,
                  orgId: req.acuc?.org_id ?? null,
                  teamConcurrency: baseConcurrency,
                  uploadedFile: file,
                  forceEngine,
                  isParse: true,
                  agentIndexOnly: readBooleanField(req, "agentIndexOnly"),
                };
                if (threatProtection !== undefined) {
                  // Rolling-deploy compatibility dual-write alongside the ctx fallback.
                  internalOptions.threatProtection = threatProtection;
                }
                const job: NuQJob<ScrapeJobData> = {
                  id: jobId,
                  status: "active",
                  createdAt: new Date(),
                  priority: jobPriority,
                  data: {
                    url: syntheticUrl,
                    mode: "single_urls",
                    ctx,
                    team_id: req.auth.team_id,
                    scrapeOptions: {
                      ...parseOptions,
                      maxAge: 0,
                      storeInCache: false,
                    } as ScrapeOptions,
                    internalOptions,
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
      } catch (error: unknown) {
        await settleBilling({ ok: false });

        const timeoutErr =
          isTransportableError(error) &&
          (error.code === "SCRAPE_TIMEOUT" ||
            error.code === "CONCURRENCY_QUEUE_TIMEOUT");

        setSpanAttributes(span, {
          "parse.error": error instanceof Error ? error.message : String(error),
          "parse.error_type": isTransportableError(error)
            ? error.code
            : "unknown",
        });

        const jobIdField = agentRequestId ? {} : { jobId };

        if (isTransportableError(error)) {
          if (!timeoutErr) {
            logger.error("Error in parseController", {
              version: "v2",
              error,
            });
          }

          const httpResponse = getErrorHttpResponse(error);
          if (httpResponse) {
            setSpanAttributes(span, {
              "parse.status_code": httpResponse.status,
            });
            return res.status(httpResponse.status).json({
              ...httpResponse.extraFields,
              success: false,
              code: error.code,
              error: error.message,
              ...jobIdField,
            });
          }

          if (error.code === "SCRAPE_ACTIONS_NOT_SUPPORTED") {
            setSpanAttributes(span, {
              "parse.status_code": 400,
            });
            return res.status(400).json({
              success: false,
              code: error.code,
              error: error.message,
              ...jobIdField,
            });
          }

          const statusCode = timeoutErr ? 408 : 500;
          setSpanAttributes(span, {
            "parse.status_code": statusCode,
          });
          return res.status(statusCode).json({
            success: false,
            code: error.code,
            error: error.message,
            ...jobIdField,
          });
        } else {
          const id = uuidv7();
          logger.error("Error in parseController", {
            version: "v2",
            error,
            errorId: id,
            path: req.path,
            teamId: req.auth.team_id,
          });
          setSpanAttributes(span, {
            "parse.status_code": 500,
            "parse.error_id": id,
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

      if (!doc) {
        await settleBilling({ ok: false });
        const id = uuidv7();
        logger.error("Parse completed without document", {
          version: "v2",
          parseId: jobId,
          errorId: id,
          teamId: req.auth.team_id,
        });
        setSpanAttributes(span, {
          "parse.status_code": 500,
          "parse.error_id": id,
        });
        return res.status(500).json({
          success: false,
          code: "UNKNOWN_ERROR",
          error: service.modules.messages.errorContact(id),
        });
      }

      if (!hasFormatOfType(req.body.formats, "rawHtml")) {
        if (doc.rawHtml) {
          delete doc.rawHtml;
        }
      }

      void settleBilling({
        ok: true,
        charged: doc.metadata?.creditsUsed,
      });

      const totalRequestTime = new Date().getTime() - middlewareStartTime;
      const controllerTime = new Date().getTime() - controllerStartTime;

      setSpanAttributes(span, {
        "parse.success": true,
        "parse.status_code": 200,
        "parse.total_request_time_ms": totalRequestTime,
        "parse.controller_time_ms": controllerTime,
        "parse.total_wait_time_ms": totalWait,
        "parse.document.status_code": doc.metadata?.statusCode,
        "parse.document.content_type": doc.metadata?.contentType,
        "parse.document.error": doc.metadata?.error,
      });

      const rawFormats = (req.body.formats ?? []) as Array<{
        type: string;
        modes?: Array<string>;
      }>;
      let usedLlm =
        rawFormats.some(
          f =>
            f.type === "json" ||
            f.type === "summary" ||
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

      const formats: Array<string> =
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

      const responseDocument: Document = {
        ...doc,
        metadata: {
          ...doc.metadata,
          concurrencyLimited,
          concurrencyQueueDurationMs: concurrencyLimited
            ? lockTime || 0
            : undefined,
        },
      };
      const payload = await finalizeResponse(
        req,
        "parse",
        {
          success: true,
          data: responseDocument,
        },
        [responseDocument],
      );
      return res.status(200).json(payload);
    },
    {
      attributes: {
        "http.method": "POST",
        "http.route": "/v2/parse",
      },
      kind: SpanKind.SERVER,
      zeroDataRetention: zeroDataRetentionTrace,
    },
  );
}
