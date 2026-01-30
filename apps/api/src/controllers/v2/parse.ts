import { Response } from "express";
import path from "node:path";
import { open, unlink } from "node:fs/promises";
import { logger as _logger } from "../../lib/logger";
import { ZodError } from "zod";
import {
  Document,
  FormatObject,
  ParseOptions,
  ParseRequest,
  parseOptionsSchema,
  parseRequestSchema,
  RequestWithAuth,
  ScrapeResponse,
  scrapeOptions,
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
import { UnsupportedFileError } from "../../scraper/scrapeURL/error";
import type { Engine } from "../../scraper/scrapeURL/engines";
import type { LocalFileInfo, LocalFileKind } from "../../scraper/scrapeURL";

const FILE_SIGNATURE_BYTES = 8;
const DOCUMENT_EXTENSIONS = [".docx", ".odt", ".rtf", ".xlsx", ".xls"];
const HTML_EXTENSIONS = [".html", ".htm"];
const MARKDOWN_EXTENSIONS = [".md"];
const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

const DOCUMENT_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
];

const HTML_MIME_TYPES = ["text/html", "application/xhtml+xml"];
const MARKDOWN_MIME_TYPES = ["text/markdown"];

type FileDetection = {
  kind: LocalFileKind;
  contentType: string;
};

type ParseMultipartBody = {
  options?: string;
  origin?: string;
  integration?: string;
  zeroDataRetention?: string | boolean;
};

async function readFileSignature(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FILE_SIGNATURE_BYTES);
    await handle.read(buffer, 0, FILE_SIGNATURE_BYTES, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function detectFileKind(
  file: Express.Multer.File,
  signature: Buffer,
): FileDetection | null {
  const mime = (file.mimetype || "").toLowerCase();
  const filename = file.originalname || "file";
  const ext = path.extname(filename).toLowerCase();
  const signatureText = signature.toString("utf8", 0, 4);
  const isPdfSignature = signatureText === "%PDF";
  const isZipSignature =
    signature.length >= 2 && signature[0] === 0x50 && signature[1] === 0x4b;

  if (mime === "application/pdf" || isPdfSignature) {
    return { kind: "pdf", contentType: "application/pdf" };
  }

  const documentMime = DOCUMENT_MIME_TYPES.find(type => mime.includes(type));
  const isDocumentExt = DOCUMENT_EXTENSIONS.includes(ext);
  if (documentMime || isDocumentExt || (isZipSignature && isDocumentExt)) {
    return {
      kind: "document",
      contentType:
        documentMime ||
        DOCUMENT_CONTENT_TYPES[ext] ||
        mime ||
        "application/octet-stream",
    };
  }

  const htmlMime = HTML_MIME_TYPES.find(type => mime.includes(type));
  if (htmlMime || HTML_EXTENSIONS.includes(ext)) {
    return { kind: "html", contentType: htmlMime || "text/html" };
  }

  const markdownMime = MARKDOWN_MIME_TYPES.find(type => mime.includes(type));
  if (markdownMime || MARKDOWN_EXTENSIONS.includes(ext)) {
    return { kind: "markdown", contentType: markdownMime || "text/markdown" };
  }

  if (mime.startsWith("text/plain")) {
    return { kind: "text", contentType: "text/plain" };
  }

  return null;
}

function getForcedEngine(kind: LocalFileKind): Engine {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "document":
      return "document";
    case "html":
    case "markdown":
    case "text":
      return "local-file";
  }
}

export async function parseController(
  req: RequestWithAuth<{}, ScrapeResponse, ParseMultipartBody>,
  res: Response<ScrapeResponse>,
) {
  return withSpan(
    "api.parse.request",
    async span => {
      const middlewareStartTime =
        (req as any).requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();
      const jobId = uuidv7();
      const preNormalizedBody = { ...req.body };
      const totalWait = 0;

      setSpanAttributes(span, {
        "parse.job_id": jobId,
        "parse.team_id": req.auth.team_id,
        "parse.api_key_id": req.acuc?.api_key_id,
        "parse.middleware_time_ms": controllerStartTime - middlewareStartTime,
      });

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        setSpanAttributes(span, {
          "parse.error": "Missing file upload",
          "parse.status_code": 400,
        });
        return res.status(400).json({
          success: false,
          code: "BAD_REQUEST",
          error: "File is required",
        });
      }

      const filePath = file.path;
      const filename = path.basename(file.originalname || "file");
      const encodedFilename = encodeURIComponent(filename);
      const pseudoUrl = `file://local/${jobId}/${encodedFilename}`;

      let doc: Document | null = null;
      let parsedOptions: ParseOptions | null = null;
      let parsedRequest: ParseRequest | null = null;
      let zeroDataRetention = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let lockTime: number | null = null;
      let concurrencyLimited = false;

      try {
        const signature = await readFileSignature(filePath);
        const detection = detectFileKind(file, signature);
        if (!detection) {
          const err = new UnsupportedFileError(
            file.mimetype || path.extname(filename) || "unknown",
          );
          setSpanAttributes(span, {
            "parse.error": err.message,
            "parse.status_code": 415,
          });
          return res.status(415).json({
            success: false,
            code: err.code,
            error: err.message,
          });
        }

        let optionsInput: unknown = {};
        if (typeof req.body?.options === "string" && req.body.options.length) {
          try {
            optionsInput = JSON.parse(req.body.options);
          } catch (error) {
            setSpanAttributes(span, {
              "parse.error": "Invalid options JSON",
              "parse.status_code": 400,
            });
            return res.status(400).json({
              success: false,
              code: "BAD_REQUEST",
              error: "Invalid options JSON",
            });
          }
        }

        const optionsData = parseOptionsSchema.parse(
          optionsInput,
        ) as ParseOptions;
        parsedOptions = optionsData;
        const requestData = parseRequestSchema.parse({
          options: optionsData,
          origin:
            typeof req.body?.origin === "string" && req.body.origin.trim()
              ? req.body.origin
              : undefined,
          integration:
            typeof req.body?.integration === "string" &&
            req.body.integration.trim()
              ? req.body.integration
              : undefined,
          zeroDataRetention: parseBoolean(req.body?.zeroDataRetention),
        });
        parsedRequest = requestData;

        const permissions = checkPermissions(
          { zeroDataRetention: requestData.zeroDataRetention },
          req.acuc?.flags,
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

        zeroDataRetention =
          req.acuc?.flags?.forceZDR || (requestData.zeroDataRetention ?? false);

        const logger = _logger.child({
          method: "parseController",
          jobId,
          noq: true,
          scrapeId: jobId,
          teamId: req.auth.team_id,
          team_id: req.auth.team_id,
          zeroDataRetention,
        });

        logger.debug("Parse " + jobId + " starting", {
          version: "v2",
          scrapeId: jobId,
          request: parsedOptions,
          originalRequest: preNormalizedBody,
          account: req.account,
        });

        await logRequest({
          id: jobId,
          kind: "scrape",
          api_version: "v2",
          team_id: req.auth.team_id,
          origin: requestData.origin ?? "api",
          integration: requestData.integration,
          target_hint: filename,
          zeroDataRetention: zeroDataRetention || false,
          api_key_id: req.acuc?.api_key_id ?? null,
        });

        setSpanAttributes(span, {
          "parse.zero_data_retention": zeroDataRetention,
          "parse.origin": requestData.origin,
          "parse.timeout": optionsData.timeout,
          "parse.file_kind": detection.kind,
          "parse.file_name": filename,
        });

        const timeout = optionsData.timeout;

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

            lockTime = Date.now() - lockStart;
            concurrencyLimited = limited;

            const forceEngine = getForcedEngine(detection.kind);

            const localFile: LocalFileInfo = {
              path: filePath,
              filename,
              contentType: detection.contentType,
              kind: detection.kind,
            };

            const job: NuQJob<ScrapeJobData> = {
              id: jobId,
              status: "active",
              createdAt: new Date(),
              priority: jobPriority,
              data: {
                url: pseudoUrl,
                mode: "single_urls",
                team_id: req.auth.team_id,
                scrapeOptions: {
                  ...scrapeOptions.parse(optionsData),
                  storeInCache: false,
                },
                internalOptions: {
                  teamId: req.auth.team_id,
                  saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
                    ? true
                    : false,
                  unnormalizedSourceURL: pseudoUrl,
                  bypassBilling: false,
                  zeroDataRetention,
                  teamFlags: req.acuc?.flags ?? null,
                  localFile,
                  forceEngine,
                  disableIndexing: true,
                },
                skipNuq: true,
                origin: requestData.origin ?? "api",
                integration: requestData.integration,
                startTime: controllerStartTime,
                zeroDataRetention,
                apiKeyId: req.acuc?.api_key_id ?? null,
                concurrencyLimited: limited,
              },
            };

            const result = await processJobInternal(job);
            return result ?? null;
          },
        );
      } catch (e) {
        if (e instanceof ZodError) {
          throw e;
        }

        setSpanAttributes(span, {
          "parse.error": e instanceof Error ? e.message : String(e),
          "parse.error_type":
            e instanceof TransportableError ? e.code : "unknown",
        });

        if (e instanceof TransportableError) {
          const statusCode =
            e.code === "SCRAPE_UNSUPPORTED_FILE_ERROR"
              ? 415
              : e.code === "SCRAPE_ACTIONS_NOT_SUPPORTED"
                ? 400
                : e.code === "SCRAPE_TIMEOUT"
                  ? 408
                  : 500;

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
          const logger = _logger.child({
            method: "parseController",
            jobId,
            teamId: req.auth.team_id,
            team_id: req.auth.team_id,
          });
          logger.error(`Error in parseController`, {
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
              file: filename,
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
        try {
          await unlink(filePath);
        } catch (error) {
          // Ignore errors when cleaning up temp files
        }
      }

      if (!hasFormatOfType(parsedOptions?.formats, "rawHtml")) {
        if (doc && doc.rawHtml) {
          delete doc.rawHtml;
        }
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
        !!hasFormatOfType(parsedOptions?.formats, "json") ||
        !!hasFormatOfType(parsedOptions?.formats, "summary");

      const formats: string[] =
        parsedOptions?.formats?.map((f: FormatObject) => f?.type) ?? [];

      _logger.info("Request metrics", {
        version: "v2",
        scrapeId: jobId,
        mode: "parse",
        middlewareStartTime,
        controllerStartTime,
        middlewareTime: controllerStartTime - middlewareStartTime,
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
            url: doc!.metadata.url ?? pseudoUrl,
            sourceURL: doc!.metadata.sourceURL ?? pseudoUrl,
            statusCode: doc!.metadata.statusCode ?? 200,
            contentType: doc!.metadata.contentType,
            concurrencyLimited,
            concurrencyQueueDurationMs: concurrencyLimited
              ? lockTime || 0
              : undefined,
          },
        },
        scrape_id: parsedRequest?.origin?.includes("website")
          ? jobId
          : undefined,
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
