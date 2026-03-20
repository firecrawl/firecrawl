import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";

/**
 * Compute word-level Jaccard similarity between two texts.
 * Strips markdown syntax and normalises whitespace so we compare
 * the underlying data, not formatting differences.
 */
function wordSimilarity(a: string, b: string): number {
  const normalise = (s: string) =>
    s
      .replace(/[#*_`\[\]()>|~\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const wordsA = new Set(normalise(a).split(" ").filter(Boolean));
  const wordsB = new Set(normalise(b).split(" ").filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  return intersection / (wordsA.size + wordsB.size - intersection);
}

export function runSelfHostedOCRExperiment(
  meta: Meta,
  base64Content: string,
  muV1Result: { markdown: string; durationMs: number },
  maxPages?: number,
  pagesProcessed?: number,
): void {
  if (
    !config.PDF_OCR_EXPERIMENT_ENABLE ||
    !config.PDF_OCR_BASE_URL ||
    Math.random() * 100 >= config.PDF_OCR_EXPERIMENT_PERCENT
  ) {
    return;
  }

  (async () => {
    const startedAt = Date.now();
    const logger = meta.logger.child({ method: "scrapePDF/selfHostedOCR" });
    try {
      const resp = await robustFetch({
        url: `${config.PDF_OCR_BASE_URL}/ocr`,
        method: "POST",
        headers: config.PDF_OCR_API_KEY
          ? { Authorization: `Bearer ${config.PDF_OCR_API_KEY}` }
          : undefined,
        body: {
          pdf: base64Content,
          scrape_id: meta.id,
          ...(maxPages !== undefined && { max_pages: maxPages }),
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
      const ocrDurationMs = Date.now() - startedAt;
      const similarity = wordSimilarity(resp.markdown, muV1Result.markdown);
      const pages = resp.pages_processed ?? pagesProcessed;
      const timeDiffMs = muV1Result.durationMs - ocrDurationMs;
      const speedup = muV1Result.durationMs > 0 && ocrDurationMs > 0
        ? Math.round((muV1Result.durationMs / ocrDurationMs) * 100) / 100
        : undefined;

      logger.info("Self-hosted OCR experiment completed", {
        scrapeId: meta.id,
        url: meta.rewrittenUrl ?? meta.url,
        ocrDurationMs,
        muV1DurationMs: muV1Result.durationMs,
        timeDiffMs,
        speedup,
        ocrMarkdownLength: resp.markdown.length,
        muV1MarkdownLength: muV1Result.markdown.length,
        wordSimilarity: Math.round(similarity * 1000) / 1000,
        failedPages: resp.failed_pages,
        pagesProcessed: pages,
        ocrPerPageMs: pages ? Math.round(ocrDurationMs / pages) : undefined,
        muV1PerPageMs: pages ? Math.round(muV1Result.durationMs / pages) : undefined,
      });
    } catch {
      // Non-blocking: instance may be down at any time, silently skip
    }
  })();
}
