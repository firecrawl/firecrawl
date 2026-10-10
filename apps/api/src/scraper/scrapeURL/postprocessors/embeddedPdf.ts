import type { Meta } from "..";
import type { Postprocessor } from ".";
import type { EngineScrapeResult } from "../engines";
import { scrapeURLWithEngine } from "../engines";
import { isPdfUrl } from "../../../lib/document-formats";

const EMBEDDED_PDF_SELECTORS = [
  'iframe[src$=".pdf"]',
  'object[data$=".pdf"]',
  'embed[src$=".pdf"]',
  'iframe[src*=".pdf"]',
  'object[data*=".pdf"]',
  'embed[src*=".pdf"]',
];

export function extractEmbeddedPdfUrl(html: string, baseUrl: string): string | null {
  const lowerHtml = html.toLowerCase();

  for (const selector of EMBEDDED_PDF_SELECTORS) {
    const attr = selector.includes("iframe") ? "src" : selector.includes("object") ? "data" : "src";
    const tag = selector.split("[")[0];

    const regex = new RegExp(
      `<${tag}[^>]*${attr}\\s*=\\s*["']([^"']*\\.pdf[^"']*)["']`,
      "i",
    );

    const match = html.match(regex);
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export const embeddedPdfPostprocessor: Postprocessor = {
  name: "embedded-pdf",
  shouldRun: (meta: Meta, url: URL, postProcessorsUsed?: string[]) => {
    if (postProcessorsUsed?.includes("embedded-pdf")) {
      return false;
    }

    if (meta.options.lockdown) {
      return false;
    }

    const isPdfRequest = meta.featureFlags.has("pdf");
    if (isPdfRequest) {
      return false;
    }

    if (meta.options.lockdown) {
      return false;
    }

    return true;
  },
  run: async (meta: Meta, engineResult: EngineScrapeResult) => {
    if (meta.options.lockdown) {
      return engineResult;
    }

    if (!engineResult.html || typeof engineResult.html !== "string") {
      return engineResult;
    }

    const baseUrl = engineResult.url;
    const embeddedPdfUrl = extractEmbeddedPdfUrl(engineResult.html, baseUrl);

    if (!embeddedPdfUrl || !isPdfUrl(embeddedPdfUrl)) {
      return engineResult;
    }

    meta.logger.info("Found embedded PDF, scraping it", {
      embeddedPdfUrl,
      baseUrl,
    });

    try {
      const pdfMeta = {
        ...meta,
        logger: meta.logger.child({ method: "embeddedPdfPostprocessor" }),
        url: embeddedPdfUrl,
        rewrittenUrl: embeddedPdfUrl,
      };

      const pdfResult = await scrapeURLWithEngine(pdfMeta, "pdf");

      return {
        ...engineResult,
        markdown: pdfResult.markdown ?? engineResult.markdown,
        html: pdfResult.html ?? engineResult.html,
        pdfMetadata: pdfResult.pdfMetadata,
        contentType: "application/pdf",
        postprocessorsUsed: [
          ...(engineResult.postprocessorsUsed ?? []),
          "embedded-pdf",
        ],
      };
    } catch (error) {
      meta.logger.warn("Failed to scrape embedded PDF, returning original result", {
        embeddedPdfUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return engineResult;
    }
  },
};