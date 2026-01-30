import { Meta } from "../..";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import * as marked from "marked";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import escapeHtml from "escape-html";
import PdfParse from "pdf-parse";
import { downloadFile } from "../utils/downloadFile";
import {
  PDFInsufficientTimeError,
  PDFPrefetchFailed,
} from "../../error";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";
import { AbortManagerThrownError } from "../../lib/abortManager";
import {
  shouldParsePDF,
  getPDFMaxPages,
} from "../../../../controllers/v2/types";
import { getPdfMetadata } from "@mendable/firecrawl-rs";

type PDFProcessorResult = { html: string; markdown?: string };

const MAX_FILE_SIZE = 19 * 1024 * 1024; // 19MB
const MILLISECONDS_PER_PAGE = 150;

async function scrapePDFWithRunPodMU(
  meta: Meta,
  tempFilePath: string,
  base64Content: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with RunPod MU", {
    tempFilePath,
  });

  if (!maxPages) {
    try {
      const cachedResult = await getPdfResultFromCache(base64Content);
      if (cachedResult) {
        meta.logger.info("Using cached RunPod MU result for PDF", {
          tempFilePath,
        });
        return cachedResult;
      }
    } catch (error) {
      meta.logger.warn("Error checking PDF cache, proceeding with RunPod MU", {
        error,
        tempFilePath,
      });
    }
  }

  meta.abort.throwIfAborted();

  meta.logger.info("Max Pdf pages", {
    tempFilePath,
    maxPages,
  });

  if (
    config.PDF_MU_V2_EXPERIMENT === "true" &&
    config.PDF_MU_V2_BASE_URL &&
    Math.random() * 100 < config.PDF_MU_V2_EXPERIMENT_PERCENT
  ) {
    (async () => {
      const pdfParseId = crypto.randomUUID();
      const startedAt = Date.now();
      const logger = meta.logger.child({ method: "scrapePDF/MUv2Experiment" });
      logger.info("MU v2 experiment started", {
        scrapeId: meta.id,
        pdfParseId,
        url: meta.rewrittenUrl ?? meta.url,
        maxPages,
      });
      try {
        const resp = await robustFetch({
          url: config.PDF_MU_V2_BASE_URL ?? "",
          method: "POST",
          headers: config.PDF_MU_V2_API_KEY
            ? { Authorization: `Bearer ${config.PDF_MU_V2_API_KEY}` }
            : undefined,
          body: {
            input: {
              file_content: base64Content,
              filename: path.basename(tempFilePath) + ".pdf",
              timeout: meta.abort.scrapeTimeout(),
              created_at: Date.now(),
              id: pdfParseId,
              ...(maxPages !== undefined && { max_pages: maxPages }),
            },
          },
          logger,
          schema: z.any(),
          mock: meta.mock,
          abort: meta.abort.asSignal(),
        });
        const body: any = resp as any;
        const tokensIn = body?.metadata?.["total-input-tokens"];
        const tokensOut = body?.metadata?.["total-output-tokens"];
        const pages = body?.metadata?.["pdf-total-pages"];
        const durationMs = Date.now() - startedAt;
        logger.info("MU v2 experiment completed", {
          durationMs,
          url: meta.rewrittenUrl ?? meta.url,
          tokensIn,
          tokensOut,
          pages,
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logger.warn("MU v2 experiment failed", { error, durationMs });
      }
    })();
  }

  const muV1StartedAt = Date.now();
  const podStart = await robustFetch({
    url: "https://api.runpod.ai/v2/" + config.RUNPOD_MU_POD_ID + "/runsync",
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RUNPOD_MU_API_KEY}`,
    },
    body: {
      input: {
        file_content: base64Content,
        filename: path.basename(tempFilePath) + ".pdf",
        timeout: meta.abort.scrapeTimeout(),
        created_at: Date.now(),
        ...(maxPages !== undefined && { max_pages: maxPages }),
      },
    },
    logger: meta.logger.child({
      method: "scrapePDFWithRunPodMU/runsync/robustFetch",
    }),
    schema: z.object({
      id: z.string(),
      status: z.string(),
      output: z
        .object({
          markdown: z.string(),
        })
        .optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  let status: string = podStart.status;
  let result: { markdown: string } | undefined = podStart.output;

  if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
    do {
      meta.abort.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 2500));
      meta.abort.throwIfAborted();
      const podStatus = await robustFetch({
        url: `https://api.runpod.ai/v2/${config.RUNPOD_MU_POD_ID}/status/${podStart.id}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.RUNPOD_MU_API_KEY}`,
        },
        logger: meta.logger.child({
          method: "scrapePDFWithRunPodMU/status/robustFetch",
        }),
        schema: z.object({
          status: z.string(),
          output: z
            .object({
              markdown: z.string(),
            })
            .optional(),
        }),
        mock: meta.mock,
        abort: meta.abort.asSignal(),
      });
      status = podStatus.status;
      result = podStatus.output;
    } while (status !== "COMPLETED" && status !== "FAILED");
  }

  if (status === "FAILED") {
    const durationMs = Date.now() - muV1StartedAt;
    meta.logger.child({ method: "scrapePDF/MUv1" }).warn("MU v1 failed", {
      durationMs,
      url: meta.rewrittenUrl ?? meta.url,
    });
    throw new Error("RunPod MU failed to parse PDF");
  }

  if (!result) {
    const durationMs = Date.now() - muV1StartedAt;
    meta.logger.child({ method: "scrapePDF/MUv1" }).warn("MU v1 failed", {
      durationMs,
      url: meta.rewrittenUrl ?? meta.url,
    });
    throw new Error("RunPod MU returned no result");
  }

  const processorResult = {
    markdown: result.markdown,
    html: await marked.parse(result.markdown, { async: true }),
  };

  if (!meta.internalOptions.zeroDataRetention) {
    try {
      await savePdfResultToCache(base64Content, processorResult);
    } catch (error) {
      meta.logger.warn("Error saving PDF to cache", {
        error,
        tempFilePath,
      });
    }
  }

  {
    const durationMs = Date.now() - muV1StartedAt;
    meta.logger.child({ method: "scrapePDF/MUv1" }).info("MU v1 completed", {
      durationMs,
      url: meta.rewrittenUrl ?? meta.url,
    });
  }

  return processorResult;
}

async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with parse-pdf", { tempFilePath });

  const result = await PdfParse(await readFile(tempFilePath));
  const escaped = escapeHtml(result.text);

  return {
    markdown: escaped,
    html: escaped,
  };
}

export async function scrapePDF(meta: Meta): Promise<EngineScrapeResult> {
  const shouldParse = shouldParsePDF(meta.options.parsers);
  const maxPages = getPDFMaxPages(meta.options.parsers);
  let tempFilePath: string;
  let responseUrl: string;
  let statusCode: number;
  let contentType: string | undefined;
  let proxyUsed: "basic" | "stealth" = "basic";

  if (meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null) {
    tempFilePath = meta.pdfPrefetch.filePath;
    responseUrl = meta.pdfPrefetch.url ?? meta.rewrittenUrl ?? meta.url;
    statusCode = meta.pdfPrefetch.status;
    contentType = meta.pdfPrefetch.contentType;
    proxyUsed = meta.pdfPrefetch.proxyUsed;

    if (contentType && !contentType.includes("application/pdf")) {
      throw new PDFPrefetchFailed();
    }
  } else {
    const file = await downloadFile(
      meta.id,
      meta.rewrittenUrl ?? meta.url,
      meta.options.skipTlsVerification,
      {
        headers: meta.options.headers,
        signal: meta.abort.asSignal(),
      },
    );

    tempFilePath = file.tempFilePath;
    responseUrl = file.response.url;
    statusCode = file.response.status;
    contentType = file.response.headers.get("Content-Type") ?? undefined;

    if (contentType && !contentType.includes("application/pdf")) {
      throw new PDFPrefetchFailed();
    }
  }

  try {
    const base64Content = (await readFile(tempFilePath)).toString("base64");

    if (!shouldParse) {
      return {
        url: responseUrl,
        statusCode,
        html: base64Content,
        markdown: base64Content,
        contentType,
        proxyUsed,
      };
    }

    const pdfMetadata = await getPdfMetadata(tempFilePath);
    const effectivePageCount = maxPages
      ? Math.min(pdfMetadata.numPages, maxPages)
      : pdfMetadata.numPages;

    if (
      effectivePageCount * MILLISECONDS_PER_PAGE >
      (meta.abort.scrapeTimeout() ?? Infinity)
    ) {
      throw new PDFInsufficientTimeError(
        effectivePageCount,
        effectivePageCount * MILLISECONDS_PER_PAGE + 5000,
      );
    }

    let result: PDFProcessorResult;

    if (
      base64Content.length < MAX_FILE_SIZE &&
      config.RUNPOD_MU_API_KEY &&
      config.RUNPOD_MU_POD_ID
    ) {
      const muV1StartedAt = Date.now();
      try {
        result = await scrapePDFWithRunPodMU(
          {
            ...meta,
            logger: meta.logger.child({
              method: "scrapePDF/scrapePDFWithRunPodMU",
            }),
          },
          tempFilePath,
          base64Content,
          maxPages,
        );
        const muV1DurationMs = Date.now() - muV1StartedAt;
        meta.logger
          .child({ method: "scrapePDF/MUv1Experiment" })
          .info("MU v1 completed", {
            durationMs: muV1DurationMs,
            url: meta.rewrittenUrl ?? meta.url,
            pages: effectivePageCount,
            success: true,
          });
      } catch (error) {
        if (error instanceof AbortManagerThrownError) {
          throw error;
        }
        meta.logger.warn("RunPod MU failed to parse PDF", { error });
        Sentry.captureException(error);
        const muV1DurationMs = Date.now() - muV1StartedAt;
        meta.logger
          .child({ method: "scrapePDF/MUv1Experiment" })
          .info("MU v1 failed", {
            durationMs: muV1DurationMs,
            url: meta.rewrittenUrl ?? meta.url,
            pages: effectivePageCount,
            success: false,
          });
        throw error;
      }
    } else {
      result = await scrapePDFWithParsePDF(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapePDF/scrapePDFWithParsePDF",
          }),
        },
        tempFilePath,
      );
    }

    return {
      url: responseUrl,
      statusCode,
      html: result.html,
      markdown: result.markdown,
      pdfMetadata: {
        // Rust parser gets the metadata incorrectly, so we overwrite the page count here with the effective page count
        // TODO: fix this later
        numPages: effectivePageCount,
        title: pdfMetadata.title,
      },
      contentType,
      proxyUsed,
    };
  } finally {
    try {
      await unlink(tempFilePath);
    } catch (error) {
      meta.logger?.warn("Failed to clean up temporary PDF file", {
        error,
        tempFilePath,
      });
    }
  }
}

export function pdfMaxReasonableTime(meta: Meta): number {
  return 120000; // Infinity, really
}
