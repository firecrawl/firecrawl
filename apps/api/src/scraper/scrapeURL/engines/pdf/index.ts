/**
 * PDF Parser Engine
 *
 * 1. **Racing Mode**: When both RunPod MU and Reducto are available (PDFs < 19MB)
 *    - Starts with RunPod MU
 *    - After 120 seconds, starts Reducto in parallel
 *    - Uses whichever finishes first
 *    - Optimal for all PDFs to minimize processing time
 *
 * 2. **RunPod MU Solo**: When only RunPod is available
 *    - For PDFs under 19MB
 *    - Cached results for better performance
 *
 * 3. **Reducto Fallback**: When RunPod fails or isn't available
 *    - Also for PDFs under 19MB (for now)
 *    - Uses Reducto as a backup option
 *
 * 4. **pdf-parse**: Final fallback for basic text extraction
 *    - Simple text extraction without formatting
 *    - Always available as last resort
 *    - Works for PDFs of any size
 */

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
const RUNPOD_TIMEOUT_BEFORE_REDUCTO = 120 * 1000; // 120 seconds - start Reducto if RunPod takes this long

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
    throw new Error("RunPod MU failed to parse PDF");
  }

  if (!result) {
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

  return processorResult;
}

async function scrapePDFWithReducto(
  meta: Meta,
  tempFilePath: string,
  base64Content: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with Reducto", {
    tempFilePath,
  });

  if (!process.env.REDUCTO_API_KEY) {
    throw new Error("Reducto API key not configured");
  }

  meta.abort.throwIfAborted();

  // Start async parse job
  const parseStart = await robustFetch({
    url: "https://platform.reducto.ai/parse_async",
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REDUCTO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: {
      document_url: meta.rewrittenUrl ?? meta.url,
      options: {
        chunking: {
          chunk_mode: "variable" as const,
        },
      },
      advanced_options: {
        ...(maxPages !== undefined && {
          page_range: {
            start: 1,
            end: maxPages,
          },
        }),
        return_ocr_data: false,
        table_output_format: "html" as const,
      },
      priority: false,
    },
    logger: meta.logger.child({
      method: "scrapePDFWithReducto/parse_async/robustFetch",
    }),
    schema: z.object({
      job_id: z.string(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  const jobId = parseStart.job_id;
  meta.logger.info("Reducto parse job started", { jobId });

  // Poll for job completion
  let attempt = 0;
  const maxAttempts = Math.ceil((meta.abort.scrapeTimeout() ?? 150000) / 3000);

  while (attempt < maxAttempts) {
    meta.abort.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3 seconds
    meta.abort.throwIfAborted();

    const jobStatus = await robustFetch({
      url: `https://platform.reducto.ai/job/${jobId}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.REDUCTO_API_KEY}`,
      },
      logger: meta.logger.child({
        method: "scrapePDFWithReducto/job_status/robustFetch",
      }),
      schema: z.object({
        status: z.enum(["Pending", "Completed", "Failed", "Idle"]),
        result: z
          .object({
            job_id: z.string().optional(),
            duration: z.number().optional(),
            pdf_url: z.string().nullable().optional(),
            studio_link: z.string().nullable().optional(),
            usage: z
              .object({
                num_pages: z.number(),
                credits: z.number().nullable().optional(),
              })
              .optional(),
            result: z.object({
              type: z.enum(["full", "url"]),
              chunks: z
                .array(
                  z.object({
                    content: z.string(),
                    embed: z.string(),
                    enriched: z.string().nullable().optional(),
                    enrichment_success: z.boolean().optional(),
                    blocks: z.array(z.any()).optional(),
                  }),
                )
                .optional(),
              url: z.string().optional(),
              result_id: z.string().optional(),
            }),
          })
          .nullable()
          .optional(),
        progress: z.number().nullable().optional(),
        reason: z.string().nullable().optional(),
      }),
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    });

    if (jobStatus.status === "Completed") {
      let markdown = "";

      // The result is a ParseResponse which contains a nested result field
      const parseResponse = jobStatus.result;
      const result = parseResponse?.result;

      if (result?.type === "full" && result.chunks) {
        // Content is inline
        markdown = result.chunks.map(chunk => chunk.content).join("\n\n");
      } else if (result?.type === "url" && result.url) {
        // Content is at URL
        const contentResponse = await robustFetch({
          url: result.url,
          method: "GET",
          logger: meta.logger.child({
            method: "scrapePDFWithReducto/content_fetch/robustFetch",
          }),
          schema: z.object({
            chunks: z.array(
              z.object({
                content: z.string(),
                embed: z.string().optional(),
                enriched: z.string().nullable().optional(),
                enrichment_success: z.boolean().optional(),
                blocks: z.array(z.any()).optional(),
              }),
            ),
          }),
          mock: meta.mock,
          abort: meta.abort.asSignal(),
        });
        markdown = contentResponse.chunks
          .map(chunk => chunk.content)
          .join("\n\n");
      }

      meta.logger.info("Reducto parse job completed");

      return {
        markdown,
        html: await marked.parse(markdown, { async: true }),
      };
    } else if (jobStatus.status === "Failed") {
      throw new Error(
        `Reducto failed to parse PDF: ${jobStatus.reason || "Unknown reason"}`,
      );
    }

    attempt++;
  }

  throw new Error("Reducto parse job timed out");
}

/**
 * Races RunPod MU and Reducto parsers for optimal performance
 * If RunPod takes longer than 120 seconds, starts Reducto in parallel
 * Returns the first successful result
 */
async function scrapePDFWithRacing(
  meta: Meta,
  tempFilePath: string,
  base64Content: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  meta.logger.info("Starting PDF processing with RunPod MU", { tempFilePath });

  let timeoutId: NodeJS.Timeout | null = null;
  let reductoPromise: Promise<PDFProcessorResult | null> | null = null;
  let reductoStarted = false;

  try {
    const runPodPromise = scrapePDFWithRunPodMU(
      {
        ...meta,
        logger: meta.logger.child({ method: "scrapePDFWithRacing/runpod" }),
      },
      tempFilePath,
      base64Content,
      maxPages,
    );

    // Set up a delayed start for Reducto
    const startReductoAfterTimeout = new Promise<PDFProcessorResult | null>(
      resolve => {
        timeoutId = setTimeout(() => {
          if (!reductoStarted && process.env.REDUCTO_API_KEY) {
            meta.logger.info(
              "RunPod MU taking > 120 seconds, starting Reducto in parallel",
            );
            reductoStarted = true;

            // Start Reducto but don't let it fail the whole operation
            reductoPromise = scrapePDFWithReducto(
              {
                ...meta,
                logger: meta.logger.child({
                  method: "scrapePDFWithRacing/reducto",
                }),
              },
              tempFilePath,
              base64Content,
              maxPages,
            ).catch(error => {
              meta.logger.warn("Reducto failed during race", { error });
              return null; // Return null instead of throwing
            });

            // Now race both parsers
            Promise.race([
              runPodPromise.catch(error => {
                meta.logger.warn("RunPod MU failed during race", { error });
                return null; // Return null instead of throwing
              }),
              reductoPromise,
            ]).then(result => {
              if (result) {
                resolve(result);
              } else {
                // Both failed, resolve with null
                resolve(null);
              }
            });
          } else {
            // Timeout fired but Reducto not available
            resolve(null);
          }
        }, RUNPOD_TIMEOUT_BEFORE_REDUCTO);
      },
    );

    // Race RunPod against the timeout
    const result = await Promise.race([
      runPodPromise.then(res => {
        // RunPod succeeded, clear the timeout
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        return res;
      }),
      startReductoAfterTimeout,
    ]);

    if (!result) {
      // If we get null, it means both parsers failed
      throw new Error("Both RunPod MU and Reducto failed to parse PDF");
    }

    meta.logger.info("PDF processing completed successfully", {
      parser: reductoStarted ? "race_winner" : "runpod",
    });

    return result;
  } finally {
    // Always clean up the timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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

  // Calculate estimated processing time
  const estimatedProcessingTime = effectivePageCount * MILLISECONDS_PER_PAGE;
  // const shouldPreferReducto = estimatedProcessingTime > REDUCTO_TIMEOUT_THRESHOLD &&
  //                            process.env.REDUCTO_API_KEY;

  const hasRunPod =
    base64Content.length < MAX_FILE_SIZE &&
    process.env.RUNPOD_MU_API_KEY &&
    process.env.RUNPOD_MU_POD_ID;
  const hasReducto =
    base64Content.length < MAX_FILE_SIZE && process.env.REDUCTO_API_KEY;

  // If both RunPod and Reducto are available and not already used, race them
  if (!result && hasRunPod && hasReducto) {
    meta.logger.info(
      "Racing RunPod MU and Reducto (with 120-second delay for Reducto)",
    );
    try {
      result = await scrapePDFWithRacing(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapePDF/scrapePDFWithRacing",
          }),
        },
        tempFilePath,
        base64Content,
        maxPages,
      );
    } catch (error) {
      if (
        error instanceof RemoveFeatureError ||
        error instanceof AbortManagerThrownError
      ) {
        throw error;
      }
      meta.logger.warn("Racing parsers failed -- falling back to next parser", {
        error,
      });
      Sentry.captureException(error);
    }
  }

  // Try RunPod alone (if racing wasn't used)
  if (!result && hasRunPod && !hasReducto) {
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
      meta.logger.info("Successfully processed PDF with RunPod MU (solo)");
    } catch (error) {
      if (
        error instanceof RemoveFeatureError ||
        error instanceof AbortManagerThrownError
      ) {
        throw error;
      }
      meta.logger.warn(
        "RunPod MU failed to parse PDF -- falling back to next parser",
        { error },
      );
      Sentry.captureException(error);
    }
  }

  // Try Reducto alone as fallback (if not already used)
  if (!result && hasReducto) {
    meta.logger.info("Trying Reducto as fallback parser");
    try {
      result = await scrapePDFWithReducto(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapePDF/scrapePDFWithReducto-fallback",
          }),
        },
        tempFilePath,
        base64Content,
        maxPages,
      );
      meta.logger.info("Successfully processed PDF with Reducto (fallback)");
    } catch (error) {
      if (
        error instanceof RemoveFeatureError ||
        error instanceof AbortManagerThrownError
      ) {
        throw error;
      }
      meta.logger.warn("Reducto fallback failed -- falling back to parse-pdf", {
        error,
      });
      Sentry.captureException(error);
    }
  }

  // Final fallback to PdfParse
  if (!result) {
    meta.logger.info("Using pdf-parse as final fallback");
    result = await scrapePDFWithParsePDF(
      {
        ...meta,
        logger: meta.logger.child({
          method: "scrapePDF/scrapePDFWithParsePDF-fallback",
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
