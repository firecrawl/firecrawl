import { Logger } from "winston";
import { config } from "../../config";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { captureExceptionWithZdrCheck } from "../../services/sentry";

import {
  type Document,
  getPDFMaxPages,
  scrapeOptions,
  type ScrapeOptions,
  type TeamFlags,
} from "../../controllers/v2/types";
import { ScrapeOptions as ScrapeOptionsV1 } from "../../controllers/v1/types";
import { logger as _logger } from "../../lib/logger";
import {
  Engine,
  EngineScrapeResult,
  FeatureFlag,
  getUnsupportedFeatures,
  scrapeURLWithEngine,
  selectLiveEngine,
  shouldUseIndex,
} from "./engines";
import { hasFormatOfType } from "../../lib/format-utils";
import {
  ActionError,
  EngineError,
  NoEnginesLeftError,
  SiteError,
  UnsupportedFileError,
  SSLError,
  PDFInsufficientTimeError,
  IndexMissError,
  NoCachedDataError,
  DNSResolutionError,
  ZDRViolationError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  ProxySelectionError,
} from "./error";
import { executeTransformers } from "./transformers";
import { LLMRefusalError } from "./transformers/llmExtract";
import { urlSpecificParams } from "./lib/urlSpecificParams";
import { loadMock, MockState } from "./lib/mock";
import { CostTracking } from "../../lib/cost-tracking";
import { getEngineForUrl } from "../WebScraper/utils/engine-forcing";
import {
  addIndexRFInsertJob,
  generateDomainSplits,
  hashURL,
  index_supabase_service,
  normalizeURLForIndex,
  useIndex,
} from "../../services/index";
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
  CrawlDenialError,
  ActionsNotSupportedError,
  HtmlTransformError,
  MarkdownConversionError,
} from "../../lib/error";
import { postprocessors } from "./postprocessors";
import { rewriteUrl } from "./lib/rewriteUrl";
import { detectSpecialtyPlan } from "./engines/utils/specialtyHandler";
import { scrapePDF } from "./engines/pdf";
import { scrapeDocument } from "./engines/document";
import { downloadFile } from "./engines/utils/downloadFile";

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
    }
  | {
      success: false;
      error: any;
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
  pdfPrefetch:
    | {
        filePath: string;
        url?: string;
        status: number;
        proxyUsed: "basic" | "stealth";
        contentType?: string;
      }
    | null
    | undefined; // undefined: no prefetch yet, null: prefetch came back empty
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
  costTracking: CostTracking;
  winnerEngine?: Engine;
  abortHandle?: NodeJS.Timeout;
};

function buildFeatureFlags(
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
): Set<FeatureFlag> {
  const flags: Set<FeatureFlag> = new Set();

  if (options.actions !== undefined) {
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

  return {
    id,
    url,
    rewrittenUrl: rewriteUrl(url),
    options: {
      ...options,
      skipTlsVerification:
        options.skipTlsVerification ??
        ((options.headers && Object.keys(options.headers).length > 0) ||
        (options.actions && options.actions.length > 0)
          ? false
          : true),
    },
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
    featureFlags: buildFeatureFlags(url, options, internalOptions),
    mock:
      options.useMock !== undefined
        ? await loadMock(options.useMock, _logger)
        : null,
    pdfPrefetch: undefined,
    documentPrefetch: undefined,
    costTracking,
  };
}

export type InternalOptions = {
  teamId: string;
  crawlId?: string;

  priority?: number; // Passed along to fire-engine
  forceEngine?: Engine;
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

  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json"; // Track original v1 format for backward compatibility

  isPreCrawl?: boolean; // Whether this scrape is part of a precrawl job
};

type EngineOutcome = {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
  result: EngineScrapeResult;
  indexAttempted: boolean;
};

async function prefetchPdfFile(
  meta: Meta,
  engineResult: EngineScrapeResult,
  contentType: string | undefined,
): Promise<Meta["pdfPrefetch"]> {
  const download = await downloadFile(
    meta.id,
    engineResult.url ?? meta.rewrittenUrl ?? meta.url,
    meta.options.skipTlsVerification,
    {
      headers: meta.options.headers,
      signal: meta.abort.asSignal(),
    },
  );

  return {
    filePath: download.tempFilePath,
    url: download.response.url,
    status: download.response.status,
    proxyUsed: engineResult.proxyUsed ?? "basic",
    contentType: download.response.headers.get("Content-Type") ?? contentType,
  };
}

async function prefetchDocumentFile(
  meta: Meta,
  engineResult: EngineScrapeResult,
  contentType: string | undefined,
): Promise<Meta["documentPrefetch"]> {
  const download = await downloadFile(
    meta.id,
    engineResult.url ?? meta.rewrittenUrl ?? meta.url,
    meta.options.skipTlsVerification,
    {
      headers: meta.options.headers,
      signal: meta.abort.asSignal(),
    },
  );

  return {
    filePath: download.tempFilePath,
    url: download.response.url,
    status: download.response.status,
    proxyUsed: engineResult.proxyUsed ?? "basic",
    contentType: download.response.headers.get("Content-Type") ?? contentType,
  };
}

async function applySpecialtyParsing(
  meta: Meta,
  engine: Engine,
  engineResult: EngineScrapeResult,
): Promise<EngineScrapeResult> {
  const specialtyPlan = await detectSpecialtyPlan(
    meta.logger.child({ method: "scrapeURL/specialtyDetect" }),
    {
      contentType: engineResult.contentType,
      body: engineResult.html,
      binaryFile: engineResult.binaryFile,
      url: engineResult.url,
      status: engineResult.statusCode,
      proxyUsed: engineResult.proxyUsed,
    },
  );

  if (!specialtyPlan) {
    return engineResult;
  }

  if (engine === "fire-engine;chrome-cdp" && !specialtyPlan.prefetch) {
    throw new EngineError(
      `Fire Engine response missing file payload for ${specialtyPlan.type}`,
    );
  }

  if (specialtyPlan.type === "pdf") {
    meta.pdfPrefetch =
      specialtyPlan.prefetch ??
      (await prefetchPdfFile(meta, engineResult, specialtyPlan.contentType));

    const pdfResult = await scrapePDF(meta);
    return {
      ...pdfResult,
      contentType:
        pdfResult.contentType ??
        specialtyPlan.contentType ??
        engineResult.contentType,
    };
  }

  if (specialtyPlan.type === "document") {
    meta.documentPrefetch =
      specialtyPlan.prefetch ??
      (await prefetchDocumentFile(meta, engineResult, specialtyPlan.contentType));

    const documentResult = await scrapeDocument(meta);
    return {
      ...documentResult,
      contentType:
        documentResult.contentType ??
        specialtyPlan.contentType ??
        engineResult.contentType,
    };
  }

  return engineResult;
}

async function selectEngineAndScrape(meta: Meta): Promise<{
  outcome: EngineOutcome;
  enginesAttempted: string[];
}> {
  const enginesAttempted: string[] = [];
  const forceEngine = meta.internalOptions.forceEngine;
  const indexEligible = forceEngine === undefined && shouldUseIndex(meta);

  if (forceEngine === "index") {
    enginesAttempted.push("index");
    const result = await scrapeURLWithEngine(meta, "index");
    return {
      outcome: {
        engine: "index",
        unsupportedFeatures: getUnsupportedFeatures(meta, "index"),
        result,
        indexAttempted: true,
      },
      enginesAttempted,
    };
  }

  if (indexEligible) {
    enginesAttempted.push("index");
    try {
      const result = await scrapeURLWithEngine(meta, "index");
      return {
        outcome: {
          engine: "index",
          unsupportedFeatures: getUnsupportedFeatures(meta, "index"),
          result,
          indexAttempted: true,
        },
        enginesAttempted,
      };
    } catch (error) {
      if (
        !(error instanceof IndexMissError) &&
        !(error instanceof NoCachedDataError)
      ) {
        throw error;
      }
    }
  }

  const liveEngine = forceEngine ?? selectLiveEngine(meta);
  const unsupportedFeatures = getUnsupportedFeatures(meta, liveEngine);
  enginesAttempted.push(liveEngine);

  if (meta.featureFlags.has("actions") && unsupportedFeatures.has("actions")) {
    throw new ActionsNotSupportedError(
      "Actions are not supported by this engine. Actions require Fire Engine (fire-engine) to be enabled.",
    );
  }

  if (
    meta.featureFlags.has("branding") &&
    unsupportedFeatures.has("branding")
  ) {
    throw new Error("Branding extraction requires Chrome CDP (fire-engine).");
  }

  const rawResult = await scrapeURLWithEngine(meta, liveEngine);
  const parsedResult = await applySpecialtyParsing(meta, liveEngine, rawResult);

  return {
    outcome: {
      engine: liveEngine,
      unsupportedFeatures,
      result: parsedResult,
      indexAttempted: indexEligible,
    },
    enginesAttempted,
  };
}

async function scrapeURLSingle(meta: Meta): Promise<ScrapeUrlResponse> {
  return withSpan("scrape.engine", async span => {
    meta.logger.info(
      `Scraping URL ${JSON.stringify(meta.rewrittenUrl ?? meta.url)}...`,
    );

    setSpanAttributes(span, {
      "engine.url": meta.rewrittenUrl ?? meta.url,
      "engine.features": Array.from(meta.featureFlags).join(","),
    });

    if (meta.internalOptions.zeroDataRetention) {
      if (meta.featureFlags.has("screenshot")) {
        throw new ZDRViolationError("screenshot");
      }

      if (meta.featureFlags.has("screenshot@fullScreen")) {
        throw new ZDRViolationError("screenshot@fullScreen");
      }

      if (
        meta.options.actions &&
        meta.options.actions.find(x => x.type === "screenshot")
      ) {
        throw new ZDRViolationError("screenshot action");
      }

      if (
        meta.options.actions &&
        meta.options.actions.find(x => x.type === "pdf")
      ) {
        throw new ZDRViolationError("pdf action");
      }
    }

    meta.abort.throwIfAborted();

    const { outcome, enginesAttempted } = await selectEngineAndScrape(meta);
    const { engine, unsupportedFeatures, result } = outcome;

    setSpanAttributes(span, {
      "engine.winner": engine,
      "engine.engines_attempted": enginesAttempted.join(","),
      "engine.unsupported_features":
        unsupportedFeatures.size > 0
          ? Array.from(unsupportedFeatures).join(",")
          : undefined,
    });

    meta.winnerEngine = engine;
    let engineResult: EngineScrapeResult = result;

    for (const postprocessor of postprocessors) {
      if (
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

    const cacheMetadata =
      outcome.indexAttempted
        ? engine === "index" && engineResult.cacheInfo
          ? {
              cacheState: "hit" as const,
              cachedAt: engineResult.cacheInfo.created_at.toISOString(),
            }
          : {
              cacheState: "miss" as const,
            }
        : {};

    let document: Document = {
      markdown: engineResult.markdown,
      rawHtml: engineResult.html,
      screenshot: engineResult.screenshot,
      actions: engineResult.actions,
      branding: engineResult.branding,
      metadata: {
        sourceURL: meta.internalOptions.unnormalizedSourceURL ?? meta.url,
        url: engineResult.url,
        statusCode: engineResult.statusCode,
        error: engineResult.error,
        numPages: engineResult.pdfMetadata?.numPages,
        ...(engineResult.pdfMetadata?.title
          ? { title: engineResult.pdfMetadata.title }
          : {}),
        contentType: engineResult.contentType,
        timezone: engineResult.timezone,
        proxyUsed: engineResult.proxyUsed ?? "basic",
        ...cacheMetadata,
        postprocessorsUsed: engineResult.postprocessorsUsed,
      },
    };

    if (unsupportedFeatures.size > 0) {
      const warning = `The engine used does not support the following features: ${[...unsupportedFeatures].join(", ")} -- your scrape may be partial.`;
      meta.logger.warn(warning, {
        engine,
        unsupportedFeatures,
      });
      document.warning =
        document.warning !== undefined
          ? document.warning + " " + warning
          : warning;
    }

    // NOTE: for sitemap, we don't need all the transformers, need to skip unused ones
    document = await executeTransformers(meta, document);

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
      unsupportedFeatures,
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
      "scrape.force_engine": internalOptions.forceEngine,
      "scrape.features": Array.from(meta.featureFlags).join(","),
    });

    meta.logger.info("scrapeURL entered");

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

    if (internalOptions.teamFlags?.checkRobotsOnScrape) {
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

    meta.logger.info("Pre-recording frequency");

    const shouldRecordFrequency =
      useIndex &&
      meta.options.storeInCache &&
      !meta.internalOptions.zeroDataRetention &&
      internalOptions.teamId !== config.PRECRAWL_TEAM_ID &&
      meta.internalOptions.isPreCrawl !== true; // sitemap crawls override teamId but keep the isPreCrawl flag
    if (shouldRecordFrequency) {
      (async () => {
        try {
          meta.logger.info("Recording frequency");
          const normalizedURL = normalizeURLForIndex(meta.url);
          const urlHash = hashURL(normalizedURL);

          let { data, error } = await index_supabase_service
            .from("index")
            .select("id, created_at, status")
            .eq("url_hash", urlHash)
            .order("created_at", { ascending: false })
            .limit(1);

          if (error) {
            meta.logger.warn("Failed to get age data", { error });
          }

          const age = data?.[0]
            ? Date.now() - new Date(data[0].created_at).getTime()
            : -1;

          const fakeDomain = meta.options.__experimental_omceDomain;
          const domainSplits = generateDomainSplits(
            new URL(normalizeURLForIndex(meta.url)).hostname,
            fakeDomain,
          );
          const domainHash = hashURL(domainSplits.slice(-1)[0]);

          const out = {
            domain_hash: domainHash,
            url: meta.url,
            age2: age,
          };

          await addIndexRFInsertJob(out);
          meta.logger.info("Recorded frequency", { out });
        } catch (error) {
          meta.logger.warn("Failed to record frequency", { error });
        }
      })();
    } else {
      meta.logger.info("Not recording frequency", {
        useIndex,
        storeInCache: meta.options.storeInCache,
        zeroDataRetention: meta.internalOptions.zeroDataRetention,
      });
    }

    try {
      const result = await scrapeURLSingle(meta);

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

      return result;
    } catch (error) {
      // if (Object.values(meta.results).length > 0 && Object.values(meta.results).every(x => x.state === "error" && x.error instanceof FEPageLoadFailed)) {
      //   throw new FEPageLoadFailed();
      // } else
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
      } else if (error instanceof ActionsNotSupportedError) {
        errorType = "ActionsNotSupportedError";
        meta.logger.warn(
          "scrapeURL: Actions are not supported by the selected engine",
          { error },
        );
      } else if (error instanceof HtmlTransformError) {
        errorType = "HtmlTransformError";
        meta.logger.warn("scrapeURL: HTML transform failed", { error });
      } else if (error instanceof MarkdownConversionError) {
        errorType = "MarkdownConversionError";
        meta.logger.warn("scrapeURL: Markdown conversion failed", { error });
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
      } else if (error instanceof EngineError) {
        errorType = "EngineError";
        meta.logger.warn("scrapeURL: Engine error", { error });
      } else if (error instanceof ProxySelectionError) {
        errorType = "ProxySelectionError";
        meta.logger.warn("scrapeURL: Proxy selection error", { error });
      } else if (error instanceof DNSResolutionError) {
        errorType = "DNSResolutionError";
        meta.logger.warn("scrapeURL: DNS resolution error", { error });
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
      };
    }
  });
}
