import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import * as marked from "marked";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import escapeHtml from "escape-html";
import PdfParse from "pdf-parse";
import { downloadFile, fetchFileToBuffer } from "../utils/downloadFile";
import {
  PDFAntibotError,
  PDFInsufficientTimeError,
  PDFPrefetchFailed,
  RemoveFeatureError,
  EngineUnsuccessfulError,
} from "../../error";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Response } from "undici";
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
    process.env.PDF_MU_V2_EXPERIMENT === "true" &&
    process.env.PDF_MU_V2_BASE_URL &&
    Math.random() * 100 <
      Number(process.env.PDF_MU_V2_EXPERIMENT_PERCENT ?? "100")
  ) {
    (async () => {
      const startedAt = Date.now();
      const logger = meta.logger.child({ method: "scrapePDF/MUv2Experiment" });
      try {
        const resp = await robustFetch({
          url: process.env.PDF_MU_V2_BASE_URL ?? "",
          method: "POST",
          body: {
            input: {
              file_content: base64Content,
              filename: path.basename(tempFilePath) + ".pdf",
              timeout: meta.abort.scrapeTimeout(),
              created_at: Date.now(),
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
    url:
      "https://api.runpod.ai/v2/" + process.env.RUNPOD_MU_POD_ID + "/runsync",
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNPOD_MU_API_KEY}`,
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
        url: `https://api.runpod.ai/v2/${process.env.RUNPOD_MU_POD_ID}/status/${podStart.id}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.RUNPOD_MU_API_KEY}`,
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

  if (!shouldParse) {
    if (meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null) {
      const content = (await readFile(meta.pdfPrefetch.filePath)).toString(
        "base64",
      );
      return {
        url: meta.pdfPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        statusCode: meta.pdfPrefetch.status,

        html: content,
        markdown: content,

        proxyUsed: meta.pdfPrefetch.proxyUsed,
      };
    } else {
      const file = await fetchFileToBuffer(meta.rewrittenUrl ?? meta.url, {
        headers: meta.options.headers,
      });

      const ct = file.response.headers.get("Content-Type");
      if (ct && !ct.includes("application/pdf")) {
        // if downloaded file wasn't a PDF
        if (meta.pdfPrefetch === undefined) {
          // for non-PDF URLs, this is expected, not anti-bot
          if (!meta.featureFlags.has("pdf")) {
            throw new EngineUnsuccessfulError("pdf");
          } else {
            throw new PDFAntibotError();
          }
        } else {
          throw new PDFPrefetchFailed();
        }
      }

      const content = file.buffer.toString("base64");
      return {
        url: file.response.url,
        statusCode: file.response.status,

        html: content,
        markdown: content,

        proxyUsed: "basic",
      };
    }
  }

  const { response, tempFilePath } =
    meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null
      ? { response: meta.pdfPrefetch, tempFilePath: meta.pdfPrefetch.filePath }
      : await downloadFile(meta.id, meta.rewrittenUrl ?? meta.url, {
          headers: meta.options.headers,
        });

  if ((response as any).headers) {
    // if downloadFile was used
    const r: Response = response as any;
    const ct = r.headers.get("Content-Type");
    if (ct && !ct.includes("application/pdf")) {
      // if downloaded file wasn't a PDF
      if (meta.pdfPrefetch === undefined) {
        // for non-PDF URLs, this is expected, not anti-bot
        if (!meta.featureFlags.has("pdf")) {
          throw new EngineUnsuccessfulError("pdf");
        } else {
          throw new PDFAntibotError();
        }
      } else {
        throw new PDFPrefetchFailed();
      }
    }
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

  let result: PDFProcessorResult | null = null;

  const base64Content = (await readFile(tempFilePath)).toString("base64");

  // First try RunPod MU if conditions are met
  if (
    base64Content.length < MAX_FILE_SIZE &&
    process.env.RUNPOD_MU_API_KEY &&
    process.env.RUNPOD_MU_POD_ID
  ) {
    // Minimal experiment: fire MU v2 in background if enabled; do not await
    if (
      process.env.PDF_MU_V2_EXPERIMENT === "true" &&
      process.env.PDF_MU_V2_BASE_URL
    ) {
      (async () => {
        const startedAt = Date.now();
        const logger = meta.logger.child({ method: "scrapePDF/MUv2Experiment" });
        try {
          const resp = await robustFetch({
            url: process.env.PDF_MU_V2_BASE_URL ?? "",
            method: "POST",
            body: {
              input: {
                file_content: base64Content,
                filename: path.basename(tempFilePath) + ".pdf",
                timeout: meta.abort.scrapeTimeout(),
                created_at: Date.now(),
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
      if (
        error instanceof RemoveFeatureError ||
        error instanceof AbortManagerThrownError
      ) {
        throw error;
      }
      meta.logger.warn(
        "RunPod MU failed to parse PDF (could be due to timeout) -- falling back to parse-pdf",
        { error },
      );
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
    }
  }

  // If RunPod MU failed or wasn't attempted, use PdfParse
  if (!result) {
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

  await unlink(tempFilePath);

  return {
    url: response.url ?? meta.rewrittenUrl ?? meta.url,
    statusCode: response.status,
    html: result?.html ?? "",
    markdown: result?.markdown ?? "",
    pdfMetadata: {
      // Rust parser gets the metadata incorrectly, so we overwrite the page count here with the effective page count
      // TODO: fix this later
      numPages: effectivePageCount,
      title: pdfMetadata.title,
    },

    proxyUsed: "basic",
  };
}

export function pdfMaxReasonableTime(meta: Meta): number {
  return 120000; // Infinity, really
}
