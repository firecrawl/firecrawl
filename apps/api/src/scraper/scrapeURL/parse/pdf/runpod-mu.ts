import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { safeMarkdownToHtml } from "./markdown-to-html";
import { z } from "zod";
import path from "node:path";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";
import type { PDFProcessorResult } from "./types";

export async function scrapePDFWithRunPodMU(
  meta: Meta,
  tempFilePath: string,
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
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
        url: meta.url,
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
          url: meta.url,
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
      url: meta.url,
      pagesProcessed,
    });
    throw new Error("RunPod MU failed to parse PDF");
  }

  if (!result) {
    const durationMs = Date.now() - muV1StartedAt;
    meta.logger.child({ method: "scrapePDF/MUv1" }).warn("MU v1 failed", {
      durationMs,
      url: meta.url,
      pagesProcessed,
    });
    throw new Error("RunPod MU returned no result");
  }

  const processorResult = {
    markdown: result.markdown,
    html: await safeMarkdownToHtml(result.markdown, meta.logger, meta.id),
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
      url: meta.url,
      pagesProcessed,
    });
  }

  return processorResult;
}
