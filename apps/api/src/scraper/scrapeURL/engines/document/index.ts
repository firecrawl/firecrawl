import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import {
  fetchFileGuardingProxyFailure,
  fetchFileToBuffer,
} from "../utils/downloadFile";
import {
  convertDocumentToMarkdown,
  parseRawDocument,
  type CoreNative,
} from "@mendable/firecrawl-rs";
import { config } from "../../../../config";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { serializeTraceContext } from "../../../../lib/otel-tracer";
import { safeMarkdownToHtml } from "../pdf/markdownToHtml";
import type { Response } from "undici";
import {
  DocumentAntibotError,
  DocumentFetchProxyError,
  EngineUnsuccessfulError,
  UnsupportedFileError,
} from "../../error";
import {
  documentContentTypeFromExtension,
  documentExtensionFromContentType,
  documentExtensionFromUrlPath,
} from "../../../../lib/document-formats";
import { readFile, unlink } from "node:fs/promises";
import { hasFilePrefetchEngine } from "../utils/specialtyHandler";

export async function scrapeDocument(meta: Meta): Promise<EngineScrapeResult> {
  // When an enabled engine prefetches files via browser handoff, this engine
  // parses prefetched files instead of downloading directly (except under an
  // explicit forceEngine pin).
  if (
    hasFilePrefetchEngine() &&
    meta.internalOptions.forceEngine === undefined &&
    meta.documentPrefetch == null
  ) {
    // A cross-type handoff (a .docx URL serving a PDF or an image) lands in
    // pdfPrefetch/imagePrefetch: the file is in hand, just not for this
    // engine — decline so the waterfall reaches the engine that can parse it.
    if (
      meta.pdfPrefetch != null ||
      meta.imagePrefetch != null ||
      !meta.featureFlags.has("document")
    ) {
      throw new EngineUnsuccessfulError("document");
    }
    throw new DocumentAntibotError();
  }

  let response: Response;
  let buffer: Buffer;
  let proxyUsed: "basic" | "stealth" = "basic";
  let tempFilePath: string | null = null;

  try {
    if (meta.documentPrefetch !== undefined && meta.documentPrefetch !== null) {
      // Use prefetched document
      tempFilePath = meta.documentPrefetch.filePath;
      buffer = await readFile(tempFilePath);

      // Create a mock response object with content-type from prefetch
      const headers = new Headers();
      if (meta.documentPrefetch.contentType) {
        headers.set("Content-Type", meta.documentPrefetch.contentType);
      }

      response = {
        url: meta.documentPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        status: meta.documentPrefetch.status,
        headers,
      } as Response;

      proxyUsed = meta.documentPrefetch.proxyUsed;
    } else {
      // Fetch the document normally
      const result = await fetchDocumentFileGuardingProxyFailure(meta, () =>
        fetchFileToBuffer(
          meta.rewrittenUrl ?? meta.url,
          meta.options.skipTlsVerification,
          {
            headers: meta.options.headers,
            signal: meta.abort.asSignal(),
          },
        ),
      );
      response = result.response;
      buffer = result.buffer;

      // Validate content type only when fetching directly (not using prefetch)
      const ct = response.headers.get("Content-Type");
      if (ct && documentExtensionFromContentType(ct) === null) {
        // The server declared a non-document type and nothing asked for a
        // document (no `document` flag means neither a document URL extension nor
        // a caller-requested format), so this engine is just the tail of the
        // stealth fallback list running against an ordinary HTML page.
        //
        // Escalating here is unrecoverable: DocumentAntibotError's remedy is to
        // clear the `document` flag and re-run the waterfall, which is a no-op
        // when the flag was never set, so the next attempt fetches the same page,
        // raises the same error, and burns attempts until SCRAPE_MAX_ATTEMPTS.
        // Fail this engine instead and let the waterfall move on. Mirrors the pdf
        // engine's guard, which is why pdf never developed this loop.
        if (!meta.featureFlags.has("document")) {
          throw new EngineUnsuccessfulError("document");
        }

        // if downloaded file wasn't a valid document, throw antibot error
        throw new DocumentAntibotError();
      }
    }

    const rawContentType = response.headers.get("content-type");
    const extension =
      documentExtensionFromContentType(rawContentType) ??
      documentExtensionFromUrlPath(new URL(response.url).pathname);

    if (config.RUST_PARSE_RAW_DOCUMENT_ENABLED) {
      const traceContext = serializeTraceContext();
      const zeroDataRetention = Boolean(
        meta.ctx.zeroDataRetention || meta.internalOptions.zeroDataRetention,
      );
      const includeRawBase64 =
        hasFormatOfType(meta.options.formats, "rawBase64") !== undefined;
      const request: CoreNative.ParseRawDocumentRequest = {
        url: response.url,
        ...(rawContentType ? { contentType: rawContentType } : {}),
        ...(extension ? { extensionHint: extension } : {}),
        includeRawBase64,
        parserOverride: "document",
      };
      const callContext: CoreNative.NativeCallContext = {
        ...(traceContext.traceparent
          ? { traceparent: traceContext.traceparent }
          : {}),
        ...(traceContext.tracestate
          ? { tracestate: traceContext.tracestate }
          : {}),
        scrapeId: meta.id,
        zeroDataRetention,
      };

      let rawResultJson: string;
      try {
        rawResultJson = await parseRawDocument(
          buffer,
          JSON.stringify(request),
          JSON.stringify(callContext),
        );
      } catch (error) {
        const unsupported = decodeNativeUnsupportedError(error);
        if (unsupported) {
          throw unsupported;
        }
        throw error;
      }

      const parsed = JSON.parse(
        rawResultJson,
      ) as CoreNative.ParseRawDocumentResult;
      const markdown = parsed.markdown ?? "";
      const html =
        parsed.html ??
        (await safeMarkdownToHtml(markdown, meta.logger, meta.id));

      return {
        url: response.url,
        statusCode: response.status,
        html,
        markdown,
        ...(parsed.rawBase64 !== undefined
          ? { rawBase64: parsed.rawBase64 }
          : {}),
        contentType:
          (rawContentType && rawContentType.trim().length > 0
            ? rawContentType
            : null) ??
          parsed.contentType ??
          (extension ? documentContentTypeFromExtension(extension) : null) ??
          "application/octet-stream",
        proxyUsed,
      };
    }

    const markdown = await convertDocumentToMarkdown(
      new Uint8Array(buffer),
      extension ?? undefined,
    );
    const html = await safeMarkdownToHtml(markdown, meta.logger, meta.id);

    return {
      url: response.url,
      statusCode: response.status,
      html,
      markdown,
      contentType:
        rawContentType ??
        (extension ? documentContentTypeFromExtension(extension) : null) ??
        "application/octet-stream",
      proxyUsed,
    };
  } finally {
    // Clean up temporary file if it was created by prefetch
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (error) {
        // Ignore errors when cleaning up temp files
        meta.logger?.warn("Failed to clean up temporary document file", {
          error,
          tempFilePath,
        });
      }
    }
  }
}

export function documentMaxReasonableTime(meta: Meta): number {
  return 15000;
}

/**
 * Guards the document engine's direct undici download: a proxy tunneling
 * failure converts into DocumentFetchProxyError, which the scrapeURL retry
 * loop handles exactly like DocumentAntibotError (clear the "document" flag,
 * re-run the waterfall, browser engine fetches the file). See
 * fetchFileGuardingProxyFailure for the conversion eligibility rules.
 */
function fetchDocumentFileGuardingProxyFailure<T>(
  meta: Meta,
  fetch: () => Promise<T>,
): Promise<T> {
  return fetchFileGuardingProxyFailure(
    {
      prefetch: meta.documentPrefetch,
      // Same conversion-eligibility rules as the pdf engine: only when
      // forceEngine is unset (retry loop recovers via browser fallback) or
      // scalar-pinned to this engine (clean error surfaces); arrays keep the
      // raw error so the waterfall continues through remaining forced
      // engines.
      flagMandated:
        (meta.internalOptions.forceEngine === undefined &&
          meta.featureFlags.has("document")) ||
        meta.internalOptions.forceEngine === "document",
      makeError: () => new DocumentFetchProxyError(),
    },
    fetch,
  );
}

function decodeNativeUnsupportedError(
  error: unknown,
): UnsupportedFileError | null {
  const message = error instanceof Error ? error.message : String(error);
  const sep = message.indexOf("|");
  if (sep <= 0) return null;
  if (message.slice(0, sep) !== "SCRAPE_UNSUPPORTED_FILE_ERROR") return null;
  try {
    const parsed = JSON.parse(message.slice(sep + 1)) as Partial<
      Extract<
        CoreNative.CoreNativeFailure,
        { code: "SCRAPE_UNSUPPORTED_FILE_ERROR" }
      >
    >;
    if (
      parsed.code === "SCRAPE_UNSUPPORTED_FILE_ERROR" &&
      typeof parsed.reason === "string"
    ) {
      return new UnsupportedFileError(parsed.reason);
    }
  } catch {
    return null;
  }
  return null;
}
