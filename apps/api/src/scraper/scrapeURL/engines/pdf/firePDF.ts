import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";
import type { PDFProcessorResult } from "./types";
import { safeMarkdownToHtml } from "./markdownToHtml";
import {
  createPdfCacheKey,
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";

export async function scrapePDFWithFirePDF(
  meta: Meta,
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
): Promise<PDFProcessorResult> {
  const logger = meta.logger;

  if (!maxPages && !meta.internalOptions.zeroDataRetention) {
    try {
      const cached = await getPdfResultFromCache(base64Content, "firepdf");
      if (cached) {
        logger.info("Using cached FirePDF result", {
          scrapeId: meta.id,
        });
        return cached;
      }
    } catch (error) {
      logger.warn("Error checking FirePDF cache, proceeding", { error });
    }
  }

  meta.abort.throwIfAborted();

  const startedAt = Date.now();

  logger.info("FirePDF started", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    maxPages,
    pagesProcessed,
  });

  const zdr = meta.internalOptions.zeroDataRetention === true;
  const pdfSha256 = createPdfCacheKey(base64Content);

  const resp = await robustFetch({
    url: `${config.FIRE_PDF_BASE_URL}/ocr`,
    method: "POST",
    headers: config.FIRE_PDF_API_KEY
      ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
      : undefined,
    body: {
      pdf: base64Content,
      scrape_id: meta.id,
      ...(maxPages !== undefined && { max_pages: maxPages }),
      // Enrichment for the fire-pdf jobs DB / dashboard. fire-pdf treats
      // these as optional — older fire-pdf builds will ignore unknown fields.
      team_id: meta.internalOptions.teamId,
      ...(meta.internalOptions.crawlId && {
        crawl_id: meta.internalOptions.crawlId,
      }),
      ...(zdr ? {} : { url: meta.rewrittenUrl ?? meta.url }),
      pdf_sha256: pdfSha256,
      source: "firecrawl",
      zdr,
    },
    logger,
    schema: z.object({
      markdown: z.string(),
      failed_pages: z.array(z.number()).nullable(),
      pages_processed: z.number().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  const durationMs = Date.now() - startedAt;
  const pages = resp.pages_processed ?? pagesProcessed;

  logger.info("FirePDF completed", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    durationMs,
    markdownLength: resp.markdown.length,
    failedPages: resp.failed_pages,
    pagesProcessed: pages,
    perPageMs: pages ? Math.round(durationMs / pages) : undefined,
  });

  const processorResult = {
    markdown: resp.markdown,
    html: await safeMarkdownToHtml(resp.markdown, logger, meta.id),
  };

  if (!maxPages && !meta.internalOptions.zeroDataRetention) {
    try {
      await savePdfResultToCache(base64Content, processorResult, "firepdf");
    } catch (error) {
      logger.warn("Error saving FirePDF result to cache", { error });
    }
  }

  return processorResult;
}
