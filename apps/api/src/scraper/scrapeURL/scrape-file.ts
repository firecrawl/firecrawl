import type {
  ScrapeOptions,
  UploadedParseFile,
} from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";

import {
  buildMeta,
  activeFeatures,
  type Meta,
  type InternalOptions,
} from "./context";
import type { Engine, Fetched, EngineScrapeResult } from "./types";
import {
  buildDocument,
  runDerive,
  runEnrich,
  handleScrapeError,
  logScrapeMetrics,
  type ScrapeUrlResponse,
} from "./pipeline";
import { shapeForFormats } from "./shape";
import { isPdf } from "./parse/pdf/pdf-utils";
import { isDocument, toHtmlResult } from "./parse/classify";
import { parsePdfBuffer } from "./parse/pdf";
import { parseDocumentBuffer } from "./parse/document";

/**
 * Parse an uploaded file buffer with the scrape pipeline. Shares the
 * derive/enrich/shape tail with `scrapeURL`, skips fetch (buffer replaces
 * network) and skips emit (caching/indexing aren't applicable to uploads).
 */
export async function scrapeFile(
  id: string,
  url: string,
  file: UploadedParseFile,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<ScrapeUrlResponse> {
  return withSpan("scrape", async span => {
    const meta = await buildMeta(
      id,
      url,
      options,
      internalOptions,
      costTracking,
    );
    const startTime = Date.now();

    setSpanAttributes(span, {
      "scrape.id": id,
      "scrape.url": url,
      "scrape.team_id": internalOptions.teamId,
      "scrape.zero_data_retention": internalOptions.zeroDataRetention,
      "scrape.features": Array.from(activeFeatures(meta)).join(","),
      "scrape.is_parse": true,
      "scrape.file_kind": file.kind ?? "unknown",
    });

    meta.logger.info("scrapeFile entered");

    try {
      const { result, engine } = await parseUpload(meta, file);
      setSpanAttributes(span, { "scrape.engine": engine });

      let document = buildDocument(meta, result, engine);
      document = await runDerive(meta, document);
      document = await runEnrich(meta, document);
      // Uploads skip emit: no caching, no indexer forward, no search index.
      document = shapeForFormats(meta, document);

      setSpanAttributes(span, {
        "scrape.final_status_code": document.metadata.statusCode,
        "scrape.final_url": document.metadata.url,
        "scrape.content_type": document.metadata.contentType,
        "scrape.success": true,
        "scrape.duration_ms": Date.now() - startTime,
      });
      logScrapeMetrics(meta, startTime, true, false);

      return { success: true, document, unsupportedFeatures: new Set() };
    } catch (error) {
      logScrapeMetrics(meta, startTime, false, false);
      return handleScrapeError(meta, error, startTime, span, internalOptions);
    } finally {
      meta.abort.dispose();
    }
  });
}

async function parseUpload(
  meta: Meta,
  file: UploadedParseFile,
): Promise<{ result: EngineScrapeResult; engine: Engine }> {
  const fetched: Fetched = {
    via: "gateway",
    url: meta.url,
    status: 200,
    headers: file.contentType
      ? [{ name: "content-type", value: file.contentType }]
      : [],
    contentType: file.contentType,
    buffer: file.buffer,
    proxyUsed: "basic",
  };

  if (file.kind === "pdf" || isPdf(fetched)) {
    return { result: await parsePdfBuffer(meta, fetched), engine: "pdf" };
  }
  if (file.kind === "document" || isDocument(fetched)) {
    return {
      result: await parseDocumentBuffer(meta, fetched),
      engine: "document",
    };
  }
  return { result: toHtmlResult(fetched), engine: "gateway" };
}
