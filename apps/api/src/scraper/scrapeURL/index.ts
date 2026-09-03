import { Logger } from "winston";
import { config } from "../../config";
import * as Sentry from "@sentry/node";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { captureExceptionWithZdrCheck } from "../../services/sentry";

import {
  applyScrapeOptionsDefaults,
  type Document,
  getPDFMaxPages,
  shouldParseImages,
  scrapeOptions,
  type ScrapeOptions,
  type TeamFlags,
} from "../../controllers/v2/types";
import { ScrapeOptions as ScrapeOptionsV1 } from "../../controllers/v1/types";
import { logger as _logger } from "../../lib/logger";
import {
  buildFallbackList,
  Engine,
  EngineScrapeResult,
  FeatureFlag,
  getEngineMaxReasonableTime,
  scrapeURLWithEngine,
  shouldUseIndex,
} from "./engines";
import { applyHandoffFeatureFlags } from "./lib/handoffFeatureFlags";
import { parseMarkdown } from "../../lib/html-to-markdown";
import { hasFormatOfType } from "../../lib/format-utils";
import {
  ActionError,
  AddFeatureError,
  AgentIndexOnlyError,
  EngineError,
  NoEnginesLeftError,
  PDFAntibotError,
  PDFFetchProxyError,
  DocumentAntibotError,
  DocumentFetchProxyError,
  RemoveFeatureError,
  SiteError,
  UnsupportedFileError,
  SSLError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  IndexMissError,
  NoCachedDataError,
  LockdownMissError,
  DNSResolutionError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  FEPageLoadFailed,
  EngineSnipedError,
  WaterfallNextEngineSignal,
  EngineUnsuccessfulError,
  ProxySelectionError,
  ScrapeRetryLimitError,
  BrandingNotSupportedError,
  XTwitterConfigurationError,
} from "./error";
import { ScrapeRetryTracker } from "./retryTracker";
import { executeTransformers } from "./transformers";
import { LLMRefusalError } from "./transformers/llmExtract";
import { urlSpecificParams } from "./lib/urlSpecificParams";
import { shouldCheckRobots } from "./shouldCheckRobots";
import { loadMock, MockState } from "./lib/mock";
import { CostTracking } from "../../lib/cost-tracking";
import { getEngineForUrl } from "../WebScraper/utils/engine-forcing";
import { useIndex } from "../../services/index";
import {
  fetchRobotsTxt,
  createRobotsChecker,
  isUrlAllowedByRobots,
} from "../../lib/robots-txt";
import { getCrawl } from "../../lib/crawl-redis";
import {
  AbortInstance,
  AbortManager,
  AbortManagerThrownError,
} from "./lib/abortManager";
import {
  ScrapeJobTimeoutError,
  composeTimeoutProcessing,
  CrawlDenialError,
  ActionsNotSupportedError,
} from "../../lib/error";
import { htmlTransform } from "./lib/removeUnwantedElements";
import { postprocessors } from "./postprocessors";
import { rewriteUrl } from "./lib/rewriteUrl";
import {
  DOCUMENT_EXTENSIONS,
  documentContentTypeFromExtension,
  documentExtensionFromContentType,
  documentExtensionFromUrlPath,
} from "../../lib/document-formats";
import {
  IMAGE_EXTENSIONS,
  imageContentTypeFromExtension,
  imageExtensionFromContentType,
  imageExtensionFromUrlPath,
} from "../../lib/image-formats";
import { imageOcrGate, type ImageOcrGate } from "../../lib/image-ocr-gate";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExchangeScrapeMetadata } from "../../lib/exchange";
import {
  checkUrl,
  type ThreatCheckDedup,
  type ThreatDecision,
  type ThreatProtectionPolicy,
} from "../../lib/threat-protection";
import { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
import { canonicalizeUrl } from "../../lib/threat-protection/providers/web-risk/canonicalize";

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
      exchange?: ExchangeScrapeMetadata;
      /**
       * Threat protection decisions made for this scrape (initial domain
       * check + any redirect re-checks, in order). Read by the billing layer
       * (`providerConsulted` drives +2/+3 credits) and the security-logging
       * layer. Only set when a threat protection policy was active.
       */
      threatDecisions?: ThreatDecision[];
    }
  | {
      success: false;
      error: any;
      threatDecisions?: ThreatDecision[];
    };

export type BrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: unknown;
};

export type Meta = {
  id: string;
  url: string;
  rewrittenUrl?: string;
  options: ScrapeOptions & { skipTlsVerification: boolean };
  internalOptions: InternalOptions;
  logger: Logger;
  abort: AbortManager;
  featureFlags: Set<FeatureFlag>;
  mock: MockState | null;
  /** Whether this scrape may OCR raster images: the request's parsers
   * include `image` (the default; a parse upload of an image always counts)
   * and the team has the imageOcr flag with FirePDF configured. Lazy and
   * memoized: the browser handoff, the image engine and the index only ask
   * once a request actually looks like an image, so plain documents never
   * pay for the team lookup. */
  imageOcrEnabled: ImageOcrGate;
  pdfPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
        /** Set when fire-engine handed the file off by GCS reference (large
         * PDFs): the object it uploaded, so the FirePDF by-reference path
         * can server-side copy it instead of re-uploading the bytes. The
         * local filePath is still materialized (sniffing and page-count
         * detection need bytes on disk). */
        gcsReference?: {
          uri: string;
          sha256?: string;
          sizeBytes?: number;
          /** int64 as the SDK's string form — never rounded through a JS
           * number. */
          generation?: string;
        };
      }
    | null
    | undefined; // undefined: no prefetch yet, null: prefetch came back empty
  // (null is preserved through the retry loop's AddFeatureError handler so
  // antibot/proxy-failure handling can tell "never attempted" apart from
  // "attempted, browser delivered no file")
  /** Live state of a by-reference FirePDF job (large PDFs) this scrape
   * submitted or adopted. Such jobs outlive an abandoned scrape BY
   * DESIGN (see fire-pdf/async.ts's cancel policy), so a SCRAPE_TIMEOUT
   * uses this to tell the caller processing continues and when a retry
   * of the same URL will pick up the finished result.
   *
   * Shaped as a mutable container (like `threatDecisions`) on purpose:
   * engine dispatch and the pdf engine hand out SPREAD COPIES of meta,
   * and only the shared inner object makes writes from those copies
   * visible to the outer timeout handler here. Set by fire-pdf/async.ts;
   * `current` is cleared when the job reaches a terminal state within
   * this scrape's lifetime. */
  largePdfProcessing?: {
    current?: {
      jobScrapeId: string;
      pagesEstimate?: number;
      submittedAtMs: number;
      jobDeadlineAtMs?: number;
      lastStatus: "queued" | "published" | "running";
      /** fire-pdf's live remaining estimate from the last poll that
       * carried one, with its observation time — one atomic datum,
       * preferred over the static per-page math when composing the
       * timeout message. */
      serverEstimate?: { remainingMs: number; observedAtMs: number };
    };
  };
  documentPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined; // undefined: no prefetch yet, null: prefetch came back empty
  // (null preserved through the retry loop, same as pdfPrefetch)
  /** Raster image handed off by the browser engine for OCR (see
   * engines/image). Same shape and null/undefined semantics as
   * documentPrefetch. */
  imagePrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined;
  fetchPrefetch:
    | {
        url?: string;
        status: number;
        bodyBuffer: Buffer;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined; // undefined: no prefetch yet, null: prefetch came back empty
  costTracking: CostTracking;
  winnerEngine?: Engine;
  abortHandle?: NodeJS.Timeout;
  audioCookies?: BrowserCookie[];
  /** Threat protection decisions made during this scrape, in order (mutable, like logs). */
  threatDecisions: ThreatDecision[];
};

function buildFeatureFlags(
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  imageOcrEnabled: boolean,
): Set<FeatureFlag> {
  const flags: Set<FeatureFlag> = new Set();

  // Lockdown forces index-only engines and ignores every request-time feature.
  // Return empty so the fallback threshold never filters index engines out.
  if (options.lockdown) {
    return flags;
  }

  if (options.actions !== undefined && options.actions.length > 0) {
    flags.add("actions");
  }

  if (hasFormatOfType(options.formats, "screenshot")) {
    if (hasFormatOfType(options.formats, "screenshot")?.fullPage) {
      flags.add("screenshot@fullScreen");
    } else {
      flags.add("screenshot");
    }
  }

  if (hasFormatOfType(options.formats, "branding")) {
    flags.add("branding");
  }

  if (hasFormatOfType(options.formats, "audio")) {
    flags.add("audio");
  }

  if (hasFormatOfType(options.formats, "video")) {
    flags.add("video");
  }

  if (options.waitFor !== 0) {
    flags.add("waitFor");
  }

  if (internalOptions.atsv) {
    flags.add("atsv");
  }

  if (options.location) {
    flags.add("location");
  }

  if (options.mobile) {
    flags.add("mobile");
  }

  if (options.skipTlsVerification) {
    flags.add("skipTlsVerification");
  }

  if (options.fastMode) {
    flags.add("useFastMode");
  }

  if (options.proxy === "stealth" || options.proxy === "enhanced") {
    flags.add("stealthProxy");
  }

  const urlO = new URL(url);
  const lowerPath = urlO.pathname.toLowerCase();

  // Check for document types first (they take precedence over PDF)
  if (documentExtensionFromUrlPath(lowerPath) !== null) {
    flags.add("document");
  } else if (lowerPath.endsWith(".pdf") || lowerPath.includes(".pdf/")) {
    // Only add PDF flag if it's not a document
    flags.add("pdf");
  } else if (imageExtensionFromUrlPath(lowerPath) !== null && imageOcrEnabled) {
    // Raster images are OCR'd through FirePDF when the request's parsers
    // include `image` (the default) and the team has the imageOcr flag (see
    // engines/image). Everyone else stays on the ordinary waterfall and
    // fails as an unsupported file, exactly as before.
    flags.add("image");
  }

  if (options.blockAds === false) {
    flags.add("disableAdblock");
  }

  return flags;
}

// The meta object contains all required information to perform a scrape.
// For example, the scrape ID, URL, options, feature flags, logs that occur while scraping.
// The meta object is usually immutable, except for the logs array, and in edge cases (e.g. a new feature is suddenly required)
// Having a meta object that is treated as immutable helps the code stay clean and easily tracable,
// while also retaining the benefits that WebScraper had from its OOP design.
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

async function writeUploadedFileToTemp(
  uploadedFilename: string,
  uploadedBuffer: Buffer,
  fallbackExtension: string,
): Promise<string> {
  const ext = path.extname(uploadedFilename).toLowerCase() || fallbackExtension;
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const tempFilePath = path.join(
    tmpdir(),
    `parse-upload-${randomUUID()}${safeExt}`,
  );
  await writeFile(tempFilePath, uploadedBuffer);
  return tempFilePath;
}

function isPdfUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";
  return (
    ext === ".pdf" ||
    normalizedType === "application/pdf" ||
    normalizedType.startsWith("application/pdf;")
  );
}

function isDocumentUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (
    DOCUMENT_EXTENSIONS.has(ext) ||
    documentExtensionFromContentType(contentType) !== null
  );
}

function isImageUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (
    IMAGE_EXTENSIONS.has(ext) ||
    imageExtensionFromContentType(contentType) !== null
  );
}

function isHtmlUpload(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const normalizedType = contentType?.toLowerCase() ?? "";
  return (
    HTML_EXTENSIONS.has(ext) ||
    normalizedType.includes("text/html") ||
    normalizedType.includes("application/xhtml+xml")
  );
}

async function buildMetaObject(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<Meta> {
  const specParams =
    urlSpecificParams[new URL(url).hostname.replace(/^www\./, "")];
  if (specParams !== undefined) {
    options = Object.assign(options, specParams.scrapeOptions);
    internalOptions = Object.assign(
      internalOptions,
      specParams.internalOptions,
    );
  }

  if (internalOptions.forceEngine === undefined) {
    const forcedEngine = getEngineForUrl(url);
    if (forcedEngine !== undefined) {
      internalOptions = Object.assign(internalOptions, {
        forceEngine: forcedEngine,
      });
    }
  }

  const logger = _logger.child({
    module: "ScrapeURL",
    scrapeId: id,
    scrapeURL: url,
    zeroDataRetention: internalOptions.zeroDataRetention,
    teamId: internalOptions.teamId,
    team_id: internalOptions.teamId,
    crawlId: internalOptions.crawlId,
  });

  const abortController = new AbortController();
  const abortHandle =
    options.timeout !== undefined
      ? setTimeout(
          () => abortController.abort(new ScrapeJobTimeoutError()),
          options.timeout,
        )
      : undefined;

  let pdfPrefetch: Meta["pdfPrefetch"] = undefined;
  let documentPrefetch: Meta["documentPrefetch"] = undefined;
  let imagePrefetch: Meta["imagePrefetch"] = undefined;
  let fetchPrefetch: Meta["fetchPrefetch"] = undefined;

  if (internalOptions.uploadedFile) {
    const { filename, buffer, contentType } = internalOptions.uploadedFile;
    const prefetchUrl = rewriteUrl(url) ?? url;

    if (isPdfUpload(filename, contentType)) {
      const filePath = await writeUploadedFileToTemp(filename, buffer, ".pdf");
      pdfPrefetch = {
        filePath,
        status: 200,
        url: prefetchUrl,
        proxyUsed: "basic",
        contentType: contentType || "application/pdf",
      };
    } else if (isDocumentUpload(filename, contentType)) {
      const ext = path.extname(filename).toLowerCase();
      const fallbackExtension =
        ext && DOCUMENT_EXTENSIONS.has(ext) ? ext : ".docx";
      const filePath = await writeUploadedFileToTemp(
        filename,
        buffer,
        fallbackExtension,
      );
      documentPrefetch = {
        filePath,
        status: 200,
        url: prefetchUrl,
        proxyUsed: "basic",
        contentType:
          contentType ||
          documentContentTypeFromExtension(fallbackExtension) ||
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
    } else if (isImageUpload(filename, contentType)) {
      const ext = path.extname(filename).toLowerCase();
      const fallbackExtension =
        ext && IMAGE_EXTENSIONS.has(ext)
          ? ext
          : (imageExtensionFromContentType(contentType) ?? ".png");
      const filePath = await writeUploadedFileToTemp(
        filename,
        buffer,
        fallbackExtension,
      );
      imagePrefetch = {
        filePath,
        status: 200,
        url: prefetchUrl,
        proxyUsed: "basic",
        contentType:
          contentType ||
          imageContentTypeFromExtension(fallbackExtension) ||
          "image/png",
      };
    } else if (isHtmlUpload(filename, contentType)) {
      fetchPrefetch = {
        url: prefetchUrl,
        status: 200,
        bodyBuffer: buffer,
        proxyUsed: "basic",
        contentType: contentType || "text/html; charset=utf-8",
      };
    } else {
      throw new UnsupportedFileError(
        contentType || path.extname(filename) || "unknown",
      );
    }
  }

  const effectiveOptions = applyScrapeOptionsDefaults(options);
  // Image OCR follows the parsers option: on by default, off when the caller
  // sends a list without `image`. A parse upload of an image is a request to
  // parse that file, so it counts regardless. The team flag is checked lazily
  // behind this.
  const imageOcrEnabled = imageOcrGate(
    internalOptions.teamId,
    internalOptions.teamFlags,
    shouldParseImages(effectiveOptions.parsers) ||
      internalOptions.uploadedFile?.kind === "image",
  );
  // Only an image-extension URL needs the answer up front; everything else
  // resolves lazily on an image handoff, if one ever happens.
  const imageOcrForUrl =
    imageExtensionFromUrlPath(new URL(url).pathname) !== null &&
    (await imageOcrEnabled());

  return {
    id,
    url,
    rewrittenUrl: rewriteUrl(url),
    options: effectiveOptions,
    internalOptions,
    logger,
    abortHandle,
    abort: new AbortManager(
      internalOptions.externalAbort,
      options.timeout !== undefined
        ? {
            signal: abortController.signal,
            tier: "scrape",
            timesOutAt: new Date(Date.now() + options.timeout),
            throwable() {
              return new ScrapeJobTimeoutError();
            },
          }
        : undefined,
    ),
    featureFlags: buildFeatureFlags(
      url,
      effectiveOptions,
      internalOptions,
      imageOcrForUrl,
    ),
    mock:
      options.useMock !== undefined
        ? await loadMock(options.useMock, _logger)
        : null,
    pdfPrefetch,
    documentPrefetch,
    imagePrefetch,
    fetchPrefetch,
    imageOcrEnabled,
    costTracking,
    threatDecisions: [],
    largePdfProcessing: {},
  };
}

export type InternalOptions = {
  teamId: string;
  crawlId?: string;

  priority?: number; // Passed along to fire-engine
  forceEngine?: Engine | Engine[];
  atsv?: boolean; // anti-bot solver, beta

  v0CrawlOnlyUrls?: boolean;
  v0DisableJsDom?: boolean;
  disableSmartWaitCache?: boolean; // Passed along to fire-engine
  isBackgroundIndex?: boolean;
  externalAbort?: AbortInstance;
  urlInvisibleInCurrentCrawl?: boolean;
  unnormalizedSourceURL?: string;

  saveScrapeResultToGCS?: boolean; // Passed along to fire-engine
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  teamFlags?: TeamFlags;
  /** Team's org, snapshotted from the request ACUC at acceptance (same
   * pattern as teamFlags). Rides the job payload so org-scoped blocklist
   * checks work without re-fetching the chunk. Required so a payload
   * builder cannot silently omit the org and skip org-scoped enforcement;
   * pass null when the caller genuinely has no org (internal/system work). */
  orgId: string | null;
  /** Team's sold concurrency, snapshotted from the request ACUC at
   * acceptance (same pattern as teamFlags). Rides the job payload so
   * downstream engines (FirePDF async account context) never re-fetch. */
  teamConcurrency?: number | null;

  /**
   * Effective threat protection policy for this scrape, resolved at the
   * controller layer (org config + per-request override). When set (and mode
   * is not "off"), the target domain is checked before any engine work, and
   * redirect destinations are re-checked. Absent => zero enforcement overhead.
   */
  threatProtection?: ThreatProtectionPolicy;

  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json"; // Track original v1 format for backward compatibility

  isPreCrawl?: boolean; // Whether this scrape is part of a precrawl job
  agentIndexOnly?: boolean; // Pre-confirmation agent key: serve from index only, never touch web/Fire Engine
  isParse?: boolean; // Whether this scrape originated from /v2/parse
  uploadedFile?: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    kind?: "html" | "pdf" | "document" | "image";
  };
};

type EngineScrapeResultWithContext = {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
  result: EngineScrapeResult;
};

const MAX_HTML_SIZE_FOR_MARKDOWN_CHECK = 300 * 1024; // 300KB

async function scrapeURLLoopIter(
  meta: Meta,
  engine: Engine,
  snipeAbort,
): Promise<EngineScrapeResult> {
  const abort = meta.abort.child(snipeAbort);
  try {
    const engineResult = await scrapeURLWithEngine(
      {
        ...meta,
        abort,
      },
      engine,
    );

    const hasMarkdown = hasFormatOfType(meta.options.formats, "markdown");
    const hasChangeTracking = hasFormatOfType(
      meta.options.formats,
      "changeTracking",
    );
    const hasJson = hasFormatOfType(meta.options.formats, "json");
    const hasSummary = hasFormatOfType(meta.options.formats, "summary");
    const hasQuestion = hasFormatOfType(meta.options.formats, "question");
    const hasHighlights = hasFormatOfType(meta.options.formats, "highlights");
    const hasQuery = hasFormatOfType(meta.options.formats, "query");
    const hasRawBase64 = hasFormatOfType(meta.options.formats, "rawBase64");
    const needsMarkdown =
      hasMarkdown ||
      hasChangeTracking ||
      hasJson ||
      hasSummary ||
      hasQuestion ||
      hasHighlights ||
      hasQuery;

    let checkMarkdown: string;
    const htmlSize = engineResult.html?.length ?? 0;
    const shouldSkipMarkdownCheck = htmlSize > MAX_HTML_SIZE_FOR_MARKDOWN_CHECK;

    if (hasRawBase64) {
      checkMarkdown = engineResult.rawBase64 !== undefined ? "rawBase64" : "";
    } else if (
      meta.internalOptions.teamId === "sitemap" ||
      meta.internalOptions.teamId === "robots-txt"
    ) {
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else if (!needsMarkdown) {
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else if (shouldSkipMarkdownCheck) {
      // Skip markdown conversion for large HTML to avoid slowdowns
      meta.logger.debug(
        "Skipping markdown conversion for quality check due to large HTML size",
        {
          htmlSize,
          threshold: MAX_HTML_SIZE_FOR_MARKDOWN_CHECK,
        },
      );
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else if (engineResult.markdown?.trim()) {
      checkMarkdown = engineResult.markdown.trim();
    } else {
      const requestId = meta.id || meta.internalOptions.crawlId;
      const zeroDataRetention = meta.internalOptions.zeroDataRetention;
      checkMarkdown = await parseMarkdown(
        await htmlTransform(
          engineResult.html,
          meta.url,
          scrapeOptions.parse({ onlyMainContent: true }),
        ),
        { logger: meta.logger, requestId, zeroDataRetention },
      );

      if (checkMarkdown.trim().length === 0) {
        checkMarkdown = await parseMarkdown(
          await htmlTransform(
            engineResult.html,
            meta.url,
            scrapeOptions.parse({ onlyMainContent: false }),
          ),
          { logger: meta.logger, requestId, zeroDataRetention },
        );
      }
    }

    // Success factors
    const isLongEnough = checkMarkdown.trim().length > 0;
    const isGoodStatusCode =
      (engineResult.statusCode >= 200 && engineResult.statusCode < 300) ||
      engineResult.statusCode === 304;
    const hasNoPageError = engineResult.error === undefined;
    // A parsed image is a complete result even when OCR found no text: the
    // image engine has already verified the bytes and run them through OCR,
    // so a blank scan or a photo legitimately comes back as an empty document.
    // Without this it would be "deemed unsuccessful" below and, as the last
    // engine in its waterfall, surface as an all-engines failure.
    const isParsedImage =
      engine === "image" && isGoodStatusCode && hasNoPageError;
    const hasRequiredOutput = hasRawBase64
      ? engineResult.rawBase64 !== undefined
      : isParsedImage || isLongEnough || !isGoodStatusCode;
    const isLikelyProxyError = [401, 403, 429].includes(
      engineResult.statusCode,
    );

    if (
      isLikelyProxyError &&
      meta.options.proxy === "auto" &&
      !meta.featureFlags.has("stealthProxy")
    ) {
      meta.logger.info(
        "Scrape via " +
          engine +
          " deemed unsuccessful due to proxy inadequacy. Adding stealthProxy flag.",
        {
          factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
          statusCode: engineResult.statusCode,
          length: engineResult.html?.trim().length ?? 0,
        },
      );
      throw new AddFeatureError(["stealthProxy"]);
    }

    // NOTE: TODO: what to do when status code is bad is tough...
    // we cannot just rely on text because error messages can be brief and not hit the limit
    // should we just use all the fallbacks and pick the one with the longest text? - mogery
    if (hasRequiredOutput) {
      meta.logger.info("Scrape via " + engine + " deemed successful.", {
        factors: {
          isLongEnough,
          isGoodStatusCode,
          hasNoPageError,
          isParsedImage,
        },
      });
      return engineResult;
    } else {
      meta.logger.warn("Scrape via " + engine + " deemed unsuccessful.", {
        factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
        length: engineResult.html?.trim().length ?? 0,
      });
      throw new EngineUnsuccessfulError(engine);
    }
  } finally {
    abort?.dispose();
  }
}

class WrappedEngineError extends Error {
  name = "WrappedEngineError";
  public engine: Engine;
  public error: any;

  constructor(engine: Engine, error: any) {
    super("WrappedEngineError");
    this.engine = engine;
    this.error = error;
  }
}

async function scrapeURLLoop(meta: Meta): Promise<ScrapeUrlResponse> {
  return withSpan("scrape.engine_loop", async span => {
    meta.logger.info(
      `Scraping URL ${JSON.stringify(meta.rewrittenUrl ?? meta.url)}...`,
    );

    setSpanAttributes(span, {
      "engine.url": meta.rewrittenUrl ?? meta.url,
      "engine.features": Array.from(meta.featureFlags).join(","),
    });

    // TODO: handle sitemap data, see WebScraper/index.ts:280
    // TODO: ScrapeEvents

    const fallbackList = await buildFallbackList(meta);

    // Check if actions are requested but no engines support them.
    // Skip when the content was already prefetched (a browser engine already
    // ran the actions and downloaded the file); the re-run only needs the
    // document/pdf engine to parse it, which does not support actions.
    // Skip when a browser engine already ran the actions — i.e. any
    // prefetch state exists, including the null sentinel (browser ran,
    // delivered no file): the re-run only needs the pdf/document engine
    // to parse the file, and the actions check must not preempt the
    // antibot/proxy recovery paths below with a misleading
    // ActionsNotSupportedError after the actions already executed.
    if (
      meta.featureFlags.has("actions") &&
      meta.pdfPrefetch === undefined &&
      meta.documentPrefetch === undefined &&
      meta.imagePrefetch === undefined
    ) {
      if (
        fallbackList.length === 0 ||
        fallbackList.every(engine => engine.unsupportedFeatures.has("actions"))
      ) {
        throw new ActionsNotSupportedError(
          "Actions are not supported by any available engines. Actions require Fire Engine (fire-engine) to be enabled.",
        );
      }
    }

    setSpanAttributes(span, {
      "engine.fallback_list": fallbackList.map(f => f.engine).join(","),
    });

    const snipeAbortController = new AbortController();
    const snipeAbort: AbortInstance = {
      signal: snipeAbortController.signal,
      tier: "engine",
      throwable() {
        return new EngineSnipedError();
      },
    };

    type EngineBundlePromise = {
      engine: Engine;
      unsupportedFeatures: Set<FeatureFlag>;
      promise: Promise<EngineScrapeResultWithContext>;
    };

    const remainingEngines = [...fallbackList];
    let enginePromises: EngineBundlePromise[] = [];
    const enginesAttempted: string[] = [];

    meta.abort.throwIfAborted();

    let result: EngineScrapeResultWithContext | null = null;

    while (remainingEngines.length > 0) {
      const { engine, unsupportedFeatures } = remainingEngines.shift()!;
      enginesAttempted.push(engine);

      const waitUntilWaterfall =
        getEngineMaxReasonableTime(meta, engine) +
        config.SCRAPEURL_ENGINE_WATERFALL_DELAY_MS;

      if (
        !isFinite(waitUntilWaterfall) ||
        isNaN(waitUntilWaterfall) ||
        waitUntilWaterfall <= 0
      ) {
        meta.logger.warn("Invalid waitUntilWaterfall value", {
          waitUntilWaterfall,
          timeout: meta.options.timeout,
          actions: !!meta.options.actions,
          hasJson: !!meta.options.formats?.find(x => x.type === "json"),
          remainingEngines: remainingEngines.length,
        });
      }

      meta.logger.info("Scraping via " + engine + "...", {
        waitUntilWaterfall,
      });

      enginePromises.push({
        engine,
        unsupportedFeatures,
        promise: (async () => {
          try {
            return {
              engine,
              unsupportedFeatures,
              result: await scrapeURLLoopIter(meta, engine, snipeAbort),
            };
          } catch (error) {
            throw new WrappedEngineError(engine, error);
          }
        })(),
      });

      while (true) {
        let timeouts: NodeJS.Timeout[] = [];
        try {
          result = await Promise.race([
            ...enginePromises.map(x => x.promise),
            ...(remainingEngines.length > 0
              ? [
                  new Promise<EngineScrapeResultWithContext>((_, reject) => {
                    timeouts.push(
                      setTimeout(() => {
                        reject(new WaterfallNextEngineSignal());
                      }, waitUntilWaterfall),
                    );
                  }),
                ]
              : []),
            new Promise<EngineScrapeResultWithContext>((_, reject) => {
              timeouts.push(
                setTimeout(() => {
                  try {
                    meta.abort.throwIfAborted();

                    // Fallback error if above doesn't throw
                    const usingDefaultTimeout =
                      meta.abort.scrapeTimeout() === undefined;
                    throw new ScrapeJobTimeoutError(
                      usingDefaultTimeout
                        ? "Scrape timed out due to maximum length of 5 minutes"
                        : "Scrape timed out",
                    );
                  } catch (error) {
                    reject(error);
                  }
                }, meta.abort.scrapeTimeout() ?? 300000),
              );
            }),
          ]);
          break;
        } catch (error) {
          if (error instanceof WrappedEngineError) {
            if (error.engine === "x-twitter") {
              meta.logger.warn("X/Twitter scrape failed fatally.", {
                error: error.error,
              });
              throw error.error;
            } else if (error.error instanceof EngineError) {
              meta.logger.warn(
                "Engine " + error.engine + " could not scrape the page.",
                {
                  error: error.error,
                },
              );
            } else if (error.error instanceof IndexMissError) {
              meta.logger.warn(
                "Engine " +
                  error.engine +
                  " could not find the page in the index.",
                {
                  error: error.error,
                },
              );
            } else if (error.error instanceof EngineUnsuccessfulError) {
              // Deliberately silent. An engine declining the page is a normal
              // waterfall outcome and is already recorded elsewhere: the
              // success-factor check logs "deemed unsuccessful" with its reasoning,
              // and engines that recognise the body as none of their business
              // (pdf/document finding HTML) are preceded by "Scraping via X...".
              // Logging again only duplicated that, ~48k lines/hour across all
              // engines. Recognised here purely so it doesn't fall through to the
              // catch-all branch and get reported as an unexpected error.
            } else if (
              error.error instanceof AddFeatureError ||
              error.error instanceof RemoveFeatureError ||
              error.error instanceof SiteError ||
              error.error instanceof SSLError ||
              error.error instanceof DNSResolutionError ||
              error.error instanceof ActionError ||
              error.error instanceof UnsupportedFileError ||
              error.error instanceof PDFAntibotError ||
              error.error instanceof PDFFetchProxyError ||
              error.error instanceof PDFOCRRequiredError ||
              error.error instanceof DocumentAntibotError ||
              error.error instanceof DocumentFetchProxyError ||
              error.error instanceof PDFInsufficientTimeError ||
              error.error instanceof ProxySelectionError ||
              error.error instanceof NoCachedDataError ||
              error.error instanceof AgentIndexOnlyError ||
              error.error instanceof XTwitterConfigurationError
            ) {
              throw error.error;
            } else if (error.error instanceof LLMRefusalError) {
              meta.logger.warn("LLM refusal encountered", {
                error: error.error,
              });
              throw error.error;
            } else if (error.error instanceof FEPageLoadFailed) {
              // This is the internal timeout bug on f-e and should be treated as an EngineError.
              meta.logger.warn("FEPageLoadFailed encountered", {
                error: error.error,
              });
            } else if (error.error instanceof AbortManagerThrownError) {
              if (error.error.tier === "engine") {
                meta.logger.warn(
                  "Engine " + error.engine + " timed out while scraping.",
                  { error: error.error },
                );
              } else {
                throw error.error;
              }
            } else {
              meta.logger.warn(
                "An unexpected error happened while scraping with " +
                  error.engine +
                  ".",
                { error },
              );
            }

            // Filter out the failed engine
            enginePromises = enginePromises.filter(
              x => x.engine !== error.engine,
            );

            // If we don't have any engines waterfalled, let's waterfall the next engine
            if (enginePromises.length === 0) {
              break;
            }

            // Otherwise, just keep racing
          } else if (
            error instanceof AddFeatureError ||
            error instanceof RemoveFeatureError
          ) {
            throw error;
          } else if (error instanceof WaterfallNextEngineSignal) {
            // It's time to waterfall the next engine
            break;
          } else if (error instanceof ScrapeJobTimeoutError) {
            throw error;
          } else if (error instanceof AbortManagerThrownError) {
            if (error.tier === "engine") {
              meta.logger.warn(
                "Engine-scoped timeout error received here. Weird!",
                { error },
              );
            }

            throw error;
          } else {
            meta.logger.warn("Unexpected error while racing engines", {
              error,
            });
            throw error;
          }
        } finally {
          for (const to of timeouts) {
            clearTimeout(to);
          }
        }
      }

      if (result === null) {
        meta.logger.info("Waterfalling to next engine...", {
          waitUntilWaterfall,
        });
      } else {
        break;
      }
    }

    snipeAbortController.abort();

    if (result === null) {
      setSpanAttributes(span, {
        "engine.no_engines_left": true,
        "engine.engines_attempted": enginesAttempted.join(","),
      });
      if (meta.options.lockdown) {
        throw new LockdownMissError();
      }
      throw new NoEnginesLeftError(fallbackList.map(x => x.engine));
    }

    // Set winner engine attributes
    setSpanAttributes(span, {
      "engine.winner": result.engine,
      "engine.engines_attempted": enginesAttempted.join(","),
      "engine.unsupported_features":
        result.unsupportedFeatures.size > 0
          ? Array.from(result.unsupportedFeatures).join(",")
          : undefined,
    });

    meta.winnerEngine = result.engine;
    let engineResult: EngineScrapeResult = result.result;
    meta.audioCookies = (
      engineResult as { audioCookies?: BrowserCookie[] }
    ).audioCookies;

    for (const postprocessor of postprocessors) {
      if (
        !hasFormatOfType(meta.options.formats, "rawBase64") &&
        postprocessor.shouldRun(
          meta,
          new URL(engineResult.url),
          engineResult.postprocessorsUsed,
        )
      ) {
        meta.logger.info("Running postprocessor " + postprocessor.name);
        try {
          engineResult = await postprocessor.run(
            {
              ...meta,
              logger: meta.logger.child({
                method: "postprocessors/" + postprocessor.name,
              }),
            },
            engineResult,
          );
        } catch (error) {
          meta.logger.warn(
            "Failed to run postprocessor " + postprocessor.name,
            {
              error,
            },
          );
        }
      }
    }

    let document: Document = {
      markdown: engineResult.markdown,
      pages: engineResult.pages,
      blocks: engineResult.blocks,
      rawHtml: engineResult.html,
      rawBase64: engineResult.rawBase64,
      json: engineResult.json,
      screenshot: engineResult.screenshot,
      actions: engineResult.actions,
      branding: engineResult.branding,
      metadata: {
        sourceURL: meta.internalOptions.unnormalizedSourceURL ?? meta.url,
        url: engineResult.url,
        statusCode: engineResult.statusCode,
        error: engineResult.error,
        numPages: engineResult.pdfMetadata?.numPages,
        ...(engineResult.pdfMetadata?.totalPages !== undefined
          ? { totalPages: engineResult.pdfMetadata.totalPages }
          : {}),
        ...(engineResult.pdfMetadata?.title
          ? { title: engineResult.pdfMetadata.title }
          : {}),
        contentType: engineResult.contentType,
        timezone: engineResult.timezone,
        proxyUsed: engineResult.proxyUsed ?? "basic",
        ...(fallbackList.find(x =>
          ["index", "index;documents"].includes(x.engine),
        )
          ? engineResult.cacheInfo
            ? {
                cacheState: "hit",
                cachedAt: engineResult.cacheInfo.created_at.toISOString(),
              }
            : {
                cacheState: "miss",
              }
          : {}),
        postprocessorsUsed: engineResult.postprocessorsUsed,
      },
    };

    if (result.unsupportedFeatures.size > 0) {
      const warning = `The engine used does not support the following features: ${[...result.unsupportedFeatures].join(", ")} -- your scrape may be partial.`;
      meta.logger.warn(warning, {
        engine: result.engine,
        unsupportedFeatures: result.unsupportedFeatures,
      });
      document.warning =
        document.warning !== undefined
          ? document.warning + " " + warning
          : warning;
    }

    // NOTE: for sitemap, we don't need all the transformers, need to skip unused ones
    document = await executeTransformers(meta, document);

    // Set final span attributes
    setSpanAttributes(span, {
      "engine.final_status_code": document.metadata.statusCode,
      "engine.final_url": document.metadata.url,
      "engine.content_type": document.metadata.contentType,
      "engine.proxy_used": document.metadata.proxyUsed,
      "engine.cache_state": document.metadata.cacheState,
      "engine.postprocessors_used": engineResult.postprocessorsUsed?.join(","),
    });

    return {
      success: true,
      document,
      unsupportedFeatures: result.unsupportedFeatures,
      exchange: engineResult.exchange,
    };
  });
}

export async function scrapeURL(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<ScrapeUrlResponse> {
  return withSpan("scrape.pipeline", async span => {
    const meta = await buildMetaObject(
      id,
      url,
      options,
      internalOptions,
      costTracking,
    );

    const startTime = Date.now();

    // Set initial span attributes
    setSpanAttributes(span, {
      "scrape.id": id,
      "scrape.url": url,
      "scrape.team_id": internalOptions.teamId,
      "scrape.crawl_id": internalOptions.crawlId,
      "scrape.zero_data_retention": internalOptions.zeroDataRetention,
      "scrape.force_engine": Array.isArray(internalOptions.forceEngine)
        ? internalOptions.forceEngine.join(",")
        : internalOptions.forceEngine,
      "scrape.features": Array.from(meta.featureFlags).join(","),
    });

    meta.logger.info("scrapeURL entered");

    // Threat protection: check the target URL BEFORE any engine selection
    // or outbound fetch. The policy is resolved at the controller layer and
    // threaded through internalOptions; absent policy = zero overhead.
    // The dedup map is scoped to this one scrape: the initial check and any
    // redirect re-check on the same URL share a single scan (one fee); a
    // redirect to a different URL is a second scan and bills a second fee
    // (see calculateThreatScanCredits).
    const threatPolicy = internalOptions.threatProtection;
    const threatDedup: ThreatCheckDedup = new Map();
    if (threatPolicy && threatPolicy.mode !== "off") {
      const initialUrl = meta.rewrittenUrl ?? meta.url;
      const decision = await checkUrl(initialUrl, threatPolicy, {
        teamId: internalOptions.teamId,
        dedup: threatDedup,
      });
      meta.threatDecisions.push(decision);
      if (!decision.allowed) {
        meta.logger.info("URL blocked by threat protection policy", {
          url: initialUrl,
          domain: decision.domain,
          rule: decision.rule,
        });
        setSpanAttributes(span, {
          "scrape.blocked_by_threat_protection": true,
        });
        return {
          success: false,
          error: new UnsafeDomainBlockedError(initialUrl, decision),
          threatDecisions: meta.threatDecisions,
        };
      }
    }

    if (meta.rewrittenUrl) {
      meta.logger.info("Rewriting URL");
      setSpanAttributes(span, {
        "scrape.rewritten_url": meta.rewrittenUrl,
      });
    }

    if (internalOptions.isPreCrawl === true) {
      setSpanAttributes(span, {
        "scrape.is_precrawl": true,
      });
    }

    if (shouldCheckRobots(options, internalOptions)) {
      await withSpan("scrape.robots_check", async robotsSpan => {
        const urlToCheck = meta.rewrittenUrl || meta.url;
        meta.logger.info("Checking robots.txt", { url: urlToCheck });

        const urlObj = new URL(urlToCheck);
        const isRobotsTxtPath = urlObj.pathname === "/robots.txt";

        setSpanAttributes(robotsSpan, {
          "robots.url": urlToCheck,
          "robots.is_robots_txt_path": isRobotsTxtPath,
        });

        if (!isRobotsTxtPath) {
          try {
            let robotsTxt: string | undefined;
            if (internalOptions.crawlId) {
              const crawl = await getCrawl(internalOptions.crawlId);
              robotsTxt = crawl?.robots;
            }

            if (!robotsTxt) {
              const { content } = await fetchRobotsTxt(
                {
                  url: urlToCheck,
                  zeroDataRetention: internalOptions.zeroDataRetention || false,
                  location: options.location,
                },
                id,
                meta.logger,
                meta.abort.asSignal(),
              );
              robotsTxt = content;
            }

            const checker = createRobotsChecker(urlToCheck, robotsTxt);
            const isAllowed = isUrlAllowedByRobots(urlToCheck, checker.robots);

            setSpanAttributes(robotsSpan, {
              "robots.allowed": isAllowed,
            });

            if (!isAllowed) {
              meta.logger.info("URL blocked by robots.txt", {
                url: urlToCheck,
              });
              setSpanAttributes(span, {
                "scrape.blocked_by_robots": true,
              });
              throw new CrawlDenialError("URL blocked by robots.txt");
            }
          } catch (error) {
            if (error instanceof CrawlDenialError) {
              throw error;
            }
            meta.logger.debug("Failed to fetch robots.txt, allowing scrape", {
              error,
              url: urlToCheck,
            });
            setSpanAttributes(robotsSpan, {
              "robots.fetch_failed": true,
            });
          }
        }
      }).catch(error => {
        if (error.message === "URL blocked by robots.txt") {
          return {
            success: false,
            error,
          };
        }
        throw error;
      });
    }

    // Initialize retry tracker with configured limits
    const retryTracker = new ScrapeRetryTracker(
      {
        maxAttempts: config.SCRAPE_MAX_ATTEMPTS,
        maxFeatureToggles: config.SCRAPE_MAX_FEATURE_TOGGLES,
        maxFeatureRemovals: config.SCRAPE_MAX_FEATURE_REMOVALS,
        maxPdfPrefetches: config.SCRAPE_MAX_PDF_PREFETCHES,
        maxDocumentPrefetches: config.SCRAPE_MAX_DOCUMENT_PREFETCHES,
      },
      meta.logger,
    );

    try {
      let result: ScrapeUrlResponse;
      while (true) {
        try {
          result = await scrapeURLLoop(meta);
          break;
        } catch (error) {
          if (
            error instanceof AddFeatureError &&
            (meta.internalOptions.forceEngine === undefined ||
              Array.isArray(meta.internalOptions.forceEngine))
          ) {
            retryTracker.record("feature_toggle", error);
            // A file handoff names the one parser that can open the file;
            // the file flag the URL extension implied earlier gives way to it.
            const nextFeatureFlags = applyHandoffFeatureFlags(
              meta.featureFlags,
              error.featureFlags,
            );
            meta.logger.debug(
              "More feature flags requested by scraper: adding " +
                error.featureFlags.join(", "),
              {
                error,
                existingFlags: meta.featureFlags,
                droppedFlags: [...meta.featureFlags].filter(
                  flag => !nextFeatureFlags.has(flag),
                ),
              },
            );
            meta.featureFlags = nextFeatureFlags;
            if (error.pdfPrefetch) {
              meta.pdfPrefetch = error.pdfPrefetch;
            } else if (error.pdfPrefetch === null) {
              // Browser round trip ran but delivered no file. Preserve the
              // null sentinel: the antibot branches below still retry (the
              // empty handoff may be transient), but the proxy-failure
              // branches fail fast instead of re-running the browser.
              meta.pdfPrefetch = null;
            }
            if (error.documentPrefetch) {
              meta.documentPrefetch = error.documentPrefetch;
            } else if (error.documentPrefetch === null) {
              meta.documentPrefetch = null;
            }
            if (error.imagePrefetch) {
              meta.imagePrefetch = error.imagePrefetch;
            } else if (error.imagePrefetch === null) {
              meta.imagePrefetch = null;
            }
          } else if (
            error instanceof RemoveFeatureError &&
            (meta.internalOptions.forceEngine === undefined ||
              Array.isArray(meta.internalOptions.forceEngine))
          ) {
            retryTracker.record("feature_removal", error);
            meta.logger.debug(
              "Incorrect feature flags reported by scraper: removing " +
                error.featureFlags.join(","),
              { error, existingFlags: meta.featureFlags },
            );
            meta.featureFlags = new Set(
              [...meta.featureFlags].filter(
                x => !error.featureFlags.includes(x),
              ),
            );
          } else if (
            error instanceof PDFAntibotError &&
            meta.internalOptions.forceEngine === undefined
          ) {
            // null = browser ran but delivered no file (possibly transient) —
            // still worth one more browser round trip, so only a real
            // prefetch object fails here.
            if (meta.pdfPrefetch != null) {
              meta.logger.error(
                "PDF was prefetched and still blocked by antibot, failing",
              );
              throw error;
            } else {
              retryTracker.record("pdf_antibot", error);
              meta.logger.debug(
                "PDF was blocked by anti-bot, prefetching with chrome-cdp",
              );
              meta.featureFlags = new Set(
                [...meta.featureFlags].filter(x => x !== "pdf"),
              );
            }
          } else if (
            error instanceof PDFFetchProxyError &&
            meta.internalOptions.forceEngine === undefined
          ) {
            // meta.pdfPrefetch distinguishes "browser never attempted"
            // (undefined — clear the pdf flag so the browser engine fetches
            // the file through fire-engine's proxies) from "browser attempted,
            // came back empty" (null — fail fast: another round trip would
            // only burn the shared antibot+proxy prefetch budget).
            if (meta.pdfPrefetch !== undefined) {
              meta.logger.error(
                "PDF was prefetched and the direct fetch still failed at the proxy, failing",
              );
              throw error;
            } else {
              retryTracker.record("pdf_fetch_proxy", error);
              meta.logger.debug(
                "PDF direct download failed at the proxy, prefetching with chrome-cdp",
              );
              meta.featureFlags = new Set(
                [...meta.featureFlags].filter(x => x !== "pdf"),
              );
            }
          } else if (
            error instanceof DocumentAntibotError &&
            meta.internalOptions.forceEngine === undefined
          ) {
            // null = browser ran but delivered no file (possibly transient) —
            // still worth one more browser round trip, so only a real
            // prefetch object fails here.
            if (meta.documentPrefetch != null) {
              meta.logger.error(
                "Document was prefetched and still blocked by antibot, failing",
              );
              throw error;
            } else {
              retryTracker.record("document_antibot", error);
              meta.logger.debug(
                "Document was blocked by anti-bot, prefetching with chrome-cdp",
              );
              meta.featureFlags = new Set(
                [...meta.featureFlags].filter(x => x !== "document"),
              );
            }
          } else if (
            error instanceof DocumentFetchProxyError &&
            meta.internalOptions.forceEngine === undefined
          ) {
            // Same undefined-vs-null distinction as the PDF branch above.
            if (meta.documentPrefetch !== undefined) {
              meta.logger.error(
                "Document was prefetched and the direct fetch still failed at the proxy, failing",
              );
              throw error;
            } else {
              retryTracker.record("document_fetch_proxy", error);
              meta.logger.debug(
                "Document direct download failed at the proxy, prefetching with chrome-cdp",
              );
              meta.featureFlags = new Set(
                [...meta.featureFlags].filter(x => x !== "document"),
              );
            }
          } else {
            throw error;
          }
        }
      }

      // Threat protection: if the scrape ended up on a different URL than
      // requested (redirect), re-check the destination URL. This closes the
      // "clean URL redirects to a blocked URL" bypass vector — including
      // same-domain redirects onto a flagged path.
      if (threatPolicy && threatPolicy.mode !== "off" && result.success) {
        const initialUrl = meta.rewrittenUrl ?? meta.url;
        const finalUrl = result.document.metadata.url;
        if (
          finalUrl &&
          canonicalizeUrl(finalUrl) !== canonicalizeUrl(initialUrl)
        ) {
          const decision = await checkUrl(finalUrl, threatPolicy, {
            teamId: internalOptions.teamId,
            dedup: threatDedup,
          });
          meta.threatDecisions.push(decision);
          if (!decision.allowed) {
            meta.logger.info(
              "Redirect destination blocked by threat protection policy",
              {
                url: finalUrl,
                domain: decision.domain,
                initialUrl,
                rule: decision.rule,
              },
            );
            setSpanAttributes(span, {
              "scrape.blocked_by_threat_protection": true,
            });
            throw new UnsafeDomainBlockedError(finalUrl, decision);
          }
        }
      }

      meta.logger.debug("scrapeURL metrics", {
        module: "scrapeURL/metrics",
        timeTaken: Date.now() - startTime,
        maxAgeValid: (meta.options.maxAge ?? 0) > 0,
        shouldUseIndex: shouldUseIndex(meta),
        success: result.success,
        indexHit:
          result.success && result.document.metadata.cacheState === "hit",
      });

      if (useIndex) {
        meta.logger.debug("scrapeURL index metrics", {
          module: "scrapeURL/index-metrics",
          timeTaken: Date.now() - startTime,
          changeTrackingEnabled: !!hasFormatOfType(
            meta.options.formats,
            "changeTracking",
          ),
          summaryEnabled: !!hasFormatOfType(meta.options.formats, "summary"),
          jsonEnabled: !!hasFormatOfType(meta.options.formats, "json"),
          screenshotEnabled: !!hasFormatOfType(
            meta.options.formats,
            "screenshot",
          ),
          imagesEnabled: !!hasFormatOfType(meta.options.formats, "images"),
          brandingEnabled: !!hasFormatOfType(meta.options.formats, "branding"),
          pdfMaxPages: getPDFMaxPages(meta.options.parsers),
          maxAge: meta.options.maxAge,
          headers: meta.options.headers
            ? Object.keys(meta.options.headers).length
            : 0,
          actions: meta.options.actions?.length ?? 0,
          proxy: meta.options.proxy,
          success: result.success,
          indexHit:
            result.success && result.document.metadata.cacheState === "hit",
        });
      }

      setSpanAttributes(span, {
        "scrape.success": true,
        "scrape.duration_ms": Date.now() - startTime,
        "scrape.index_hit":
          result.success && result.document.metadata.cacheState === "hit",
      });

      return meta.threatDecisions.length > 0
        ? { ...result, threatDecisions: meta.threatDecisions }
        : result;
    } catch (error) {
      // if (Object.values(meta.results).length > 0 && Object.values(meta.results).every(x => x.state === "error" && x.error instanceof FEPageLoadFailed)) {
      //   throw new FEPageLoadFailed();
      // } else
      // A timed-out large-PDF scrape leaves its fire-pdf job running by
      // design (fire-pdf/async.ts cancel policy); upgrade the timeout
      // error IN PLACE so the caller learns processing continues and
      // when a retry of the same URL picks the result up. Covers both
      // the engine race's own timer and the abort manager's inner
      // timeout, which exits through the early rethrow below.
      const timeoutCandidate =
        error instanceof AbortManagerThrownError ? error.inner : error;
      if (
        meta.largePdfProcessing?.current &&
        timeoutCandidate instanceof ScrapeJobTimeoutError &&
        timeoutCandidate.processing === undefined
      ) {
        const composed = composeTimeoutProcessing({
          ...meta.largePdfProcessing.current,
          nowMs: Date.now(),
        });
        timeoutCandidate.processing = composed.details;
        timeoutCandidate.message = composed.message;
      }

      meta.logger.debug("scrapeURL metrics", {
        module: "scrapeURL/metrics",
        timeTaken: Date.now() - startTime,
        maxAgeValid: (meta.options.maxAge ?? 0) > 0,
        shouldUseIndex: shouldUseIndex(meta),
        success: false,
        indexHit: false,
      });

      if (useIndex) {
        meta.logger.debug("scrapeURL index metrics", {
          module: "scrapeURL/index-metrics",
          timeTaken: Date.now() - startTime,
          changeTrackingEnabled: !!hasFormatOfType(
            meta.options.formats,
            "changeTracking",
          ),
          summaryEnabled: !!hasFormatOfType(meta.options.formats, "summary"),
          jsonEnabled: !!hasFormatOfType(meta.options.formats, "json"),
          screenshotEnabled: !!hasFormatOfType(
            meta.options.formats,
            "screenshot",
          ),
          imagesEnabled: !!hasFormatOfType(meta.options.formats, "images"),
          brandingEnabled: !!hasFormatOfType(meta.options.formats, "branding"),
          pdfMaxPages: getPDFMaxPages(meta.options.parsers),
          maxAge: meta.options.maxAge,
          headers: meta.options.headers
            ? Object.keys(meta.options.headers).length
            : 0,
          actions: meta.options.actions?.length ?? 0,
          proxy: meta.options.proxy,
          success: false,
          indexHit: false,
        });
      }

      // Set error attributes on span
      let errorType = "unknown";
      if (error instanceof NoEnginesLeftError) {
        errorType = "NoEnginesLeftError";
        meta.logger.warn("scrapeURL: All scraping engines failed!", { error });
      } else if (error instanceof LLMRefusalError) {
        errorType = "LLMRefusalError";
        meta.logger.warn("scrapeURL: LLM refused to extract content", {
          error,
        });
      } else if (
        error instanceof Error &&
        error.message.includes("Invalid schema for response_format")
      ) {
        errorType = "LLMSchemaError";
        // TODO: separate into custom error
        meta.logger.warn("scrapeURL: LLM schema error", { error });
        // TODO: results?
      } else if (error instanceof SiteError) {
        errorType = "SiteError";
        meta.logger.warn("scrapeURL: Site failed to load in browser", {
          error,
        });
      } else if (error instanceof SSLError) {
        errorType = "SSLError";
        meta.logger.warn("scrapeURL: SSL error", { error });
      } else if (error instanceof ActionError) {
        errorType = "ActionError";
        meta.logger.warn("scrapeURL: Action(s) failed to complete", { error });
      } else if (error instanceof UnsupportedFileError) {
        errorType = "UnsupportedFileError";
        meta.logger.warn("scrapeURL: Tried to scrape unsupported file", {
          error,
        });
      } else if (error instanceof PDFInsufficientTimeError) {
        errorType = "PDFInsufficientTimeError";
        meta.logger.warn("scrapeURL: Insufficient time to process PDF", {
          error,
        });
      } else if (error instanceof PDFOCRRequiredError) {
        errorType = "PDFOCRRequiredError";
        meta.logger.warn(
          "scrapeURL: PDF requires OCR but fast mode was requested",
          {
            error,
          },
        );
      } else if (error instanceof PDFPrefetchFailed) {
        errorType = "PDFPrefetchFailed";
        meta.logger.warn(
          "scrapeURL: Failed to prefetch PDF that is protected by anti-bot",
          { error },
        );
      } else if (error instanceof DocumentPrefetchFailed) {
        errorType = "DocumentPrefetchFailed";
        meta.logger.warn(
          "scrapeURL: Failed to prefetch document that is protected by anti-bot",
          { error },
        );
      } else if (error instanceof PDFFetchProxyError) {
        errorType = "PDFFetchProxyError";
        meta.logger.warn(
          "scrapeURL: PDF download failed at the proxy and could not be recovered via browser prefetch",
          { error },
        );
      } else if (error instanceof DocumentFetchProxyError) {
        errorType = "DocumentFetchProxyError";
        meta.logger.warn(
          "scrapeURL: Document download failed at the proxy and could not be recovered via browser prefetch",
          { error },
        );
      } else if (error instanceof BrandingNotSupportedError) {
        errorType = "BrandingNotSupportedError";
        meta.logger.warn("scrapeURL: Branding not supported for this content", {
          error,
        });
      } else if (error instanceof ProxySelectionError) {
        errorType = "ProxySelectionError";
        meta.logger.warn("scrapeURL: Proxy selection error", { error });
      } else if (error instanceof DNSResolutionError) {
        errorType = "DNSResolutionError";
        meta.logger.warn("scrapeURL: DNS resolution error", { error });
      } else if (error instanceof ScrapeRetryLimitError) {
        errorType = "ScrapeRetryLimitError";
        meta.logger.warn("scrapeURL: Retry limit reached", {
          error,
          retryStats: error.stats,
        });
      } else if (error instanceof UnsafeDomainBlockedError) {
        errorType = "UnsafeDomainBlockedError";
        meta.logger.warn(
          "scrapeURL: Domain blocked by threat protection policy",
          {
            error,
            domain: error.domain,
            rule: error.decision.rule,
          },
        );
      } else if (error instanceof AbortManagerThrownError) {
        errorType = "AbortManagerThrownError";
        throw error.inner;
      } else {
        captureExceptionWithZdrCheck(error, {
          extra: {
            zeroDataRetention: internalOptions.zeroDataRetention ?? false,
          },
        });
        meta.logger.error("scrapeURL: Unexpected error happened", { error });
        // TODO: results?
      }

      setSpanAttributes(span, {
        "scrape.success": false,
        "scrape.error": error instanceof Error ? error.message : String(error),
        "scrape.error_type": errorType,
        "scrape.duration_ms": Date.now() - startTime,
      });

      return {
        success: false,
        error,
        ...(meta.threatDecisions.length > 0
          ? { threatDecisions: meta.threatDecisions }
          : {}),
      };
    }
  });
}
