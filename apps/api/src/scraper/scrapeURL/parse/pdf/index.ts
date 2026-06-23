import { Meta } from "../..";
import { config } from "../../../../config";
import type { EngineScrapeResult, Fetched } from "../../types";
import { safeMarkdownToHtml } from "./markdown-to-html";
import { PDFInsufficientTimeError, PDFOCRRequiredError } from "../../error";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { v7 as uuid } from "uuid";
import { AbortManagerThrownError } from "../../lib/abort-manager";
import {
  shouldParsePDF,
  getPDFMaxPages,
  getPDFMode,
} from "../../../../controllers/v2/types";
import type { PDFMode } from "../../../../controllers/v2/types";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";
import { MAX_FILE_SIZE, MILLISECONDS_PER_PAGE } from "./types";
import type { PDFProcessorResult } from "./types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../lib/native-logging";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { scrapePDFWithRunPodMU } from "./runpod-mu";
import { scrapePDFWithFirePDF } from "./fire-pdf";
import { scrapePDFWithParsePDF } from "./pdf-parse";
import { captureExceptionWithZdrCheck } from "../../../../services/sentry";
import { isPdf } from "./pdf-utils";
import { comparePdfOutputs } from "./shadow-comparison";

type ShadowCandidate = {
  rustMarkdown: string;
  pdfType: string;
  confidence: number;
  isComplex: boolean;
  ineligibleReason: string | null;
  pagesNeedingOcr?: number[];
};

type DetectOutcome = {
  pageCount: number;
  title?: string;
  result?: PDFProcessorResult;
  shadow?: ShadowCandidate;
  ocrRequired?: string;
};

function childMeta(meta: Meta, method: string): Meta {
  return { ...meta, logger: meta.logger.child({ method }) };
}

function captureScrape(meta: Meta, error: unknown): void {
  captureExceptionWithZdrCheck(error, {
    extra: {
      zeroDataRetention: meta.internalOptions.zeroDataRetention ?? false,
      scrapeId: meta.id,
      teamId: meta.internalOptions.teamId,
      url: meta.url,
    },
  });
}

function clampPages(pageCount: number, maxPages: number | undefined): number {
  return maxPages ? Math.min(pageCount, maxPages) : pageCount;
}

function getIneligibleReason(
  result: ReturnType<typeof processPdf>,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  if (!result.markdown?.length)
    return "empty markdown (unexpected for TextBased)";
  return null;
}

async function withTempPdf<T>(
  meta: Meta,
  buffer: Buffer,
  fn: (tempFilePath: string) => Promise<T>,
): Promise<T> {
  const tempFilePath = path.join(
    os.tmpdir(),
    `tempFile-${meta.id}--${uuid()}.pdf`,
  );
  await writeFile(tempFilePath, buffer);
  try {
    return await fn(tempFilePath);
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

async function detectLegacy(
  meta: Meta,
  tempFilePath: string,
  mode: PDFMode,
  maxPages: number | undefined,
  rustEnabled: boolean,
): Promise<DetectOutcome> {
  const logger = meta.logger.child({ method: "scrapePDF/processPdf" });
  const nativeCtx = { scrapeId: meta.id, url: meta.url };
  try {
    const startedAt = Date.now();
    const r = await withSpan("native.pdf.detect", async span => {
      const result = detectPdf(tempFilePath, nativeCtx);
      setSpanAttributes(span, {
        "native.module": "pdf",
        "native.pdf_type": result.pdfType,
        "native.page_count": result.pageCount,
      });
      emitNativeLogs(result.logs, meta.logger, "pdf.detect");
      return result;
    });
    logger.info("detectPdf completed", {
      durationMs: Date.now() - startedAt,
      pdfType: r.pdfType,
      pageCount: r.pageCount,
      url: meta.url,
      rustEnabled,
      mode,
    });
    return {
      pageCount: clampPages(r.pageCount, maxPages),
      title: r.title ?? undefined,
    };
  } catch (error) {
    extractAndEmitNativeLogs(error, meta.logger, "pdf.detect");
    logger.warn("detectPdf failed", { error, url: meta.url });
    captureScrape(meta, error);
    return { pageCount: 0 };
  }
}

async function detectAndExtract(
  meta: Meta,
  tempFilePath: string,
  mode: PDFMode,
  maxPages: number | undefined,
): Promise<DetectOutcome> {
  const logger = meta.logger.child({ method: "scrapePDF/processPdf" });
  const nativeCtx = { scrapeId: meta.id, url: meta.url };
  try {
    const startedAt = Date.now();
    const r = await withSpan("native.pdf.process", async span => {
      const result = processPdf(tempFilePath, maxPages ?? undefined, nativeCtx);
      setSpanAttributes(span, {
        "native.module": "pdf",
        "native.pdf_type": result.pdfType,
        "native.page_count": result.pageCount,
        "native.confidence": result.confidence,
        "native.is_complex": result.isComplex,
      });
      emitNativeLogs(result.logs, meta.logger, "pdf.process");
      return result;
    });
    logger.info("processPdf completed", {
      durationMs: Date.now() - startedAt,
      pdfType: r.pdfType,
      pageCount: r.pageCount,
      confidence: r.confidence,
      isComplex: r.isComplex,
      markdownLength: r.markdown?.length ?? 0,
      url: meta.url,
      mode,
    });

    const ineligibleReason = getIneligibleReason(r);
    const eligible = !ineligibleReason;
    logger.info("Rust PDF eligibility", {
      rust_pdf_eligible: eligible,
      reason: ineligibleReason ?? "eligible",
      url: meta.url,
      pdfType: r.pdfType,
      isComplex: r.isComplex,
      pageCount: r.pageCount,
      confidence: r.confidence,
      mode,
    });

    const pageCount = clampPages(r.pageCount, maxPages);
    const title = r.title ?? undefined;

    // Shadow-compare when Rust produced meaningful output but wasn't eligible
    // for direct serving (ineligible TextBased or Mixed with substantial text).
    const charsPerPage = (r.markdown?.length ?? 0) / Math.max(r.pageCount, 1);
    const shadow: ShadowCandidate | undefined =
      !eligible &&
      r.markdown &&
      config.PDF_SHADOW_COMPARISON_ENABLE &&
      (r.pdfType === "TextBased" ||
        (r.pdfType === "Mixed" && charsPerPage >= 200))
        ? {
            rustMarkdown: r.markdown,
            pdfType: r.pdfType,
            confidence: r.confidence,
            isComplex: r.isComplex,
            ineligibleReason,
            pagesNeedingOcr: r.pagesNeedingOcr,
          }
        : undefined;

    if (
      mode === "fast" &&
      (r.pdfType === "Scanned" || r.pdfType === "ImageBased")
    ) {
      return { pageCount, title, shadow, ocrRequired: r.pdfType };
    }

    let result: PDFProcessorResult | undefined;
    if (eligible && r.markdown) {
      const html = await safeMarkdownToHtml(r.markdown, logger, meta.id);
      result = { markdown: r.markdown, html };
    }

    return { pageCount, title, result, shadow };
  } catch (error) {
    extractAndEmitNativeLogs(error, meta.logger, "pdf.process");
    logger.warn("processPdf failed, falling back to MU/PdfParse", {
      error,
      url: meta.url,
    });
    captureScrape(meta, error);
    return { pageCount: 0 };
  }
}

function scheduleShadowCompare(
  meta: Meta,
  shadow: ShadowCandidate,
  muMarkdown: string,
  pageCount: number,
): void {
  const logger = meta.logger.child({ method: "scrapePDF/shadow-comparison" });
  const isZdr = !!meta.internalOptions.zeroDataRetention;
  (async () => {
    try {
      const metrics = comparePdfOutputs(shadow.rustMarkdown, muMarkdown);
      const ocrPages = shadow.pagesNeedingOcr?.length ?? 0;
      logger.info("shadow comparison complete", {
        scrapeId: meta.id,
        url: isZdr ? undefined : meta.url,
        pageCount,
        pdfType: shadow.pdfType,
        confidence: shadow.confidence,
        isComplex: shadow.isComplex,
        ineligibleReason: shadow.ineligibleReason,
        ocrPageCount: ocrPages,
        ocrPageRatio:
          pageCount > 0 ? Math.round((ocrPages * 100) / pageCount) / 100 : 0,
        ...metrics.overall,
      });
    } catch (error) {
      logger.warn("shadow comparison failed", { error });
    }
  })();
}

async function tryFirePDF(
  meta: Meta,
  base64Content: string,
  maxPages: number | undefined,
  pageCount: number,
  forced: boolean,
): Promise<PDFProcessorResult | null> {
  try {
    return await scrapePDFWithFirePDF(
      childMeta(meta, "scrapePDF/fire-pdf"),
      base64Content,
      maxPages,
      pageCount,
    );
  } catch (error) {
    if (error instanceof AbortManagerThrownError) throw error;
    if (forced) {
      meta.logger.error("FirePDF failed (forced, no fallback)", {
        method: "scrapePDF/fire-pdf",
        error,
      });
      throw error;
    }
    meta.logger.warn("FirePDF failed -- falling back to MinerU", {
      method: "scrapePDF/fire-pdf",
      error,
      event: "pdf_engine_fallback",
      scrape_id: meta.id,
      team_id: meta.internalOptions.teamId,
      from_engine: "firepdf",
      to_engine: "mineru",
      error_class:
        (error as { name?: unknown })?.name != null
          ? String((error as { name?: unknown }).name)
          : undefined,
      error_message: String(
        (error as { message?: unknown })?.message ?? "",
      ).slice(0, 500),
    });
    return null;
  }
}

async function tryRunPodMU(
  meta: Meta,
  tempFilePath: string,
  base64Content: string,
  maxPages: number | undefined,
  pageCount: number,
  shadow: ShadowCandidate | undefined,
): Promise<PDFProcessorResult | null> {
  const startedAt = Date.now();
  const expLogger = meta.logger.child({ method: "scrapePDF/MUv1Experiment" });
  try {
    const r = await scrapePDFWithRunPodMU(
      childMeta(meta, "scrapePDF/scrapePDFWithRunPodMU"),
      tempFilePath,
      base64Content,
      maxPages,
      pageCount,
    );
    expLogger.info("MU v1 completed", {
      durationMs: Date.now() - startedAt,
      url: meta.url,
      pages: pageCount,
      success: true,
    });
    if (shadow && r?.markdown && config.PDF_SHADOW_COMPARISON_ENABLE) {
      scheduleShadowCompare(meta, shadow, r.markdown, pageCount);
    }
    return r;
  } catch (error) {
    if (error instanceof AbortManagerThrownError) throw error;
    meta.logger.warn(
      "RunPod MU failed to parse PDF (could be due to timeout) -- falling back to parse-pdf",
      { error },
    );
    captureScrape(meta, error);
    expLogger.info("MU v1 failed", {
      durationMs: Date.now() - startedAt,
      url: meta.url,
      pages: pageCount,
      success: false,
    });
    return null;
  }
}

async function ocrFallback(
  meta: Meta,
  tempFilePath: string,
  opts: {
    forceFirePDF: boolean;
    routeToMinerU: boolean;
    maxPages: number | undefined;
    pageCount: number;
    shadow: ShadowCandidate | undefined;
  },
): Promise<PDFProcessorResult | null> {
  const base64Content = (await readFile(tempFilePath)).toString("base64");

  const useFirePDF =
    opts.forceFirePDF ||
    (!opts.routeToMinerU &&
      config.FIRE_PDF_ENABLE &&
      config.FIRE_PDF_BASE_URL &&
      base64Content.length < MAX_FILE_SIZE &&
      Math.random() * 100 < config.FIRE_PDF_PERCENT);

  if (useFirePDF) {
    const r = await tryFirePDF(
      meta,
      base64Content,
      opts.maxPages,
      opts.pageCount,
      opts.forceFirePDF,
    );
    if (r) return r;
  }

  if (
    !opts.forceFirePDF &&
    base64Content.length < MAX_FILE_SIZE &&
    config.RUNPOD_MU_API_KEY &&
    config.RUNPOD_MU_POD_ID
  ) {
    const r = await tryRunPodMU(
      meta,
      tempFilePath,
      base64Content,
      opts.maxPages,
      opts.pageCount,
      opts.shadow,
    );
    if (r) return r;
  }

  return null;
}

export async function parsePdfBuffer(
  meta: Meta,
  fetched: Fetched,
): Promise<EngineScrapeResult> {
  if (!isPdf(fetched)) {
    throw new Error("parsePdfBuffer called with non-PDF bytes");
  }

  if (!shouldParsePDF(meta.options.parsers)) {
    const content = fetched.buffer.toString("base64");
    return {
      url: fetched.url,
      statusCode: fetched.status,
      html: content,
      markdown: content,
      contentType: "application/pdf",
      proxyUsed: fetched.proxyUsed ?? "basic",
    };
  }

  const mode = getPDFMode(meta.options.parsers);
  const maxPages = getPDFMaxPages(meta.options.parsers);

  return withTempPdf(meta, fetched.buffer, async tempFilePath => {
    const forceFirePDF =
      !!meta.options.__forceFirePDF && !!config.FIRE_PDF_BASE_URL;
    const rustEnabled = !!config.PDF_RUST_EXTRACT_ENABLE;

    // Route a percentage of traffic directly to MinerU (bypassing Rust).
    // Forced Fire PDF wins over routing.
    const routeToMinerU =
      !forceFirePDF &&
      config.MINERU_PERCENT > 0 &&
      Math.random() * 100 < config.MINERU_PERCENT;
    if (routeToMinerU) {
      meta.logger
        .child({ method: "scrapePDF/processPdf" })
        .info("Routing to MinerU via MINERU_PERCENT", {
          mineruPercent: config.MINERU_PERCENT,
          url: meta.url,
        });
    }

    const useRust =
      rustEnabled && mode !== "ocr" && !forceFirePDF && !routeToMinerU;
    const detection = useRust
      ? await detectAndExtract(meta, tempFilePath, mode, maxPages)
      : await detectLegacy(meta, tempFilePath, mode, maxPages, rustEnabled);

    if (detection.ocrRequired) {
      throw new PDFOCRRequiredError(detection.ocrRequired);
    }

    let result = detection.result ?? null;

    // Only enforce the per-page budget when we need an OCR/MU pass.
    // Rust extraction is fast enough that the constraint doesn't apply.
    if (
      !result &&
      detection.pageCount > 0 &&
      detection.pageCount * MILLISECONDS_PER_PAGE >
        (meta.abort.scrapeTimeout() ?? Infinity)
    ) {
      throw new PDFInsufficientTimeError(
        detection.pageCount,
        detection.pageCount * MILLISECONDS_PER_PAGE + 5000,
      );
    }

    const skipOCR = rustEnabled && mode === "fast" && !routeToMinerU;
    if (!result && !skipOCR) {
      result = await ocrFallback(meta, tempFilePath, {
        forceFirePDF,
        routeToMinerU,
        maxPages,
        pageCount: detection.pageCount,
        shadow: detection.shadow,
      });
    }

    if (!result && !forceFirePDF) {
      result = await scrapePDFWithParsePDF(
        childMeta(meta, "scrapePDF/scrapePDFWithParsePDF"),
        tempFilePath,
      );
    }

    return {
      url: fetched.url,
      statusCode: fetched.status,
      html: result?.html ?? "",
      markdown: result?.markdown ?? "",
      pdfMetadata: {
        numPages: detection.pageCount,
        title: detection.title,
      },
      contentType: "application/pdf",
      proxyUsed: fetched.proxyUsed ?? "basic",
    };
  });
}
