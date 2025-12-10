import { Logger } from "winston";
import { config } from "../../config";
import * as Sentry from "@sentry/node";
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
  buildFallbackList,
  Engine,
  EngineScrapeResult,
  FeatureFlag,
  getEngineMaxReasonableTime,
  scrapeURLWithEngine,
  shouldUseIndex,
} from "./engines";
import { parseMarkdown } from "../../lib/html-to-markdown";
import { hasFormatOfType } from "../../lib/format-utils";
import {
  ActionError,
  AddFeatureError,
  EngineError,
  NoEnginesLeftError,
  PDFAntibotError,
  DocumentAntibotError,
  RemoveFeatureError,
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
  FEPageLoadFailed,
  EngineSnipedError,
  WaterfallNextEngineSignal,
  EngineUnsuccessfulError,
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
import {
  AbortInstance,
  AbortManager,
  AbortManagerThrownError,
} from "./lib/abortManager";
import { ScrapeJobTimeoutError, CrawlDenialError } from "../../lib/error";
import { htmlTransform } from "./lib/removeUnwantedElements";
import { postprocessors } from "./postprocessors";
import { rewriteUrl } from "./lib/rewriteUrl";

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

  if (options.proxy === "stealth") {
    flags.add("stealthProxy");
  }

  const urlO = new URL(url);
  const lowerPath = urlO.pathname.toLowerCase();

  // Check for document types first (they take precedence over PDF)
  const isDocument =
    lowerPath.endsWith(".docx") ||
    lowerPath.endsWith(".odt") ||
    lowerPath.endsWith(".rtf") ||
    lowerPath.endsWith(".xlsx") ||
    lowerPath.endsWith(".xls") ||
    lowerPath.includes(".docx/") ||
    lowerPath.includes(".odt/") ||
    lowerPath.includes(".rtf/") ||
    lowerPath.includes(".xlsx/") ||
    lowerPath.includes(".xls/");

  if (isDocument) {
    flags.add("document");
  } else if (lowerPath.endsWith(".pdf") || lowerPath.includes(".pdf/")) {
    // Only add PDF flag if it's not a document
    flags.add("pdf");
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
          () =>
            abortController.abort(
              new ScrapeJobTimeoutError("Scrape timed out"),
            ),
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
              return new ScrapeJobTimeoutError("Scrape timed out");
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

  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json"; // Track original v1 format for backward compatibility

  isPreCrawl?: boolean; // Whether this scrape is part of a precrawl job
};

type EngineScrapeResultWithContext = {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
  result: EngineScrapeResult;
};

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

    let checkMarkdown: string;
    if (
      meta.internalOptions.teamId === "sitemap" ||
      meta.internalOptions.teamId === "robots-txt"
    ) {
      checkMarkdown = engineResult.html?.trim() ?? "";
    } else {
      checkMarkdown = await parseMarkdown(
        await htmlTransform(
          engineResult.html,
          meta.url,
          scrapeOptions.parse({ onlyMainContent: true }),
        ),
      );

      if (checkMarkdown.trim().length === 0) {
        checkMarkdown = await parseMarkdown(
          await htmlTransform(
            engineResult.html,
            meta.url,
            scrapeOptions.parse({ onlyMainContent: false }),
          ),
        );
      }
    }

    // Success factors
    const isLongEnough = checkMarkdown.trim().length > 0;
    const isGoodStatusCode =
      (engineResult.statusCode >= 200 && engineResult.statusCode < 300) ||
      engineResult.statusCode === 304;
    const hasNoPageError = engineResult.error === undefined;
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
      );
      throw new AddFeatureError(["stealthProxy"]);
    }

    // NOTE: TODO: what to do when status code is bad is tough...
    // we cannot just rely on text because error messages can be brief and not hit the limit
    // should we just use all the fallbacks and pick the one with the longest text? - mogery
    if (isLongEnough || !isGoodStatusCode) {
      meta.logger.info("Scrape via " + engine + " deemed successful.", {
        factors: { isLongEnough, isGoodStatusCode, hasNoPageError },
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

    // TODO: handle sitemap data, see WebScraper/index.ts:280
    // TODO: ScrapeEvents

    const fallbackList = await buildFallbackList(meta);

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
            if (error.error instanceof EngineError) {
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
            } else if (
              error.error instanceof AddFeatureError ||
              error.error instanceof RemoveFeatureError ||
              error.error instanceof SiteError ||
              error.error instanceof SSLError ||
              error.error instanceof DNSResolutionError ||
              error.error instanceof ActionError ||
              error.error instanceof UnsupportedFileError ||
              error.error instanceof PDFAntibotError ||
              error.error instanceof DocumentAntibotError ||
              error.error instanceof PDFInsufficientTimeError ||
              error.error instanceof ProxySelectionError ||
              error.error instanceof NoCachedDataError
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
            const { content: robotsTxt } = await fetchRobotsTxt(
              {
                url: urlToCheck,
                zeroDataRetention: internalOptions.zeroDataRetention || false,
                location: options.location,
              },
              id,
              meta.logger,
              meta.abort.asSignal(),
            );

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
      // temporary fix until new scrapeURL system
      let documentReattempted = false;
      let pdfReattempted = false;

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
            // note: we might want to reattempt check here too
            meta.logger.debug(
              "More feature flags requested by scraper: adding " +
                error.featureFlags.join(", "),
              { error, existingFlags: meta.featureFlags },
            );
            meta.featureFlags = new Set(
              [...meta.featureFlags].concat(error.featureFlags),
            );
            if (error.pdfPrefetch) {
              meta.pdfPrefetch = error.pdfPrefetch;
            }
            if (error.documentPrefetch) {
              meta.documentPrefetch = error.documentPrefetch;
            }
          } else if (
            error instanceof RemoveFeatureError &&
            (meta.internalOptions.forceEngine === undefined ||
              Array.isArray(meta.internalOptions.forceEngine))
          ) {
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
            if (meta.pdfPrefetch !== undefined) {
              meta.logger.error(
                "PDF was prefetched and still blocked by antibot, failing",
              );
              throw error;
            } else {
              if (!pdfReattempted) {
                meta.logger.debug(
                  "PDF was blocked by anti-bot, prefetching with chrome-cdp",
                );

                pdfReattempted = true;
                meta.featureFlags = new Set(
                  [...meta.featureFlags].filter(x => x !== "pdf"),
                );
              } else {
                meta.logger.debug(
                  "PDF was blocked by anti-bot, skipping as it was already attempted",
                );
              }
            }
          } else if (
            error instanceof DocumentAntibotError &&
            meta.internalOptions.forceEngine === undefined
          ) {
            if (meta.documentPrefetch !== undefined) {
              meta.logger.error(
                "Document was prefetched and still blocked by antibot, failing",
              );
              throw error;
            } else {
              if (!documentReattempted) {
                meta.logger.debug(
                  "Document was blocked by anti-bot, prefetching with chrome-cdp",
                );

                documentReattempted = true;
                meta.featureFlags = new Set(
                  [...meta.featureFlags].filter(x => x !== "document"),
                );
              } else {
                meta.logger.debug(
                  "Document was blocked by anti-bot, skipping as it was already attempted",
                );
              }
            }
          } else {
            throw error;
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
          changeTracking: hasFormatOfType(
            meta.options.formats,
            "changeTracking",
          ),
          branding: hasFormatOfType(meta.options.formats, "branding"),
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
          changeTracking: hasFormatOfType(
            meta.options.formats,
            "changeTracking",
          ),
          branding: hasFormatOfType(meta.options.formats, "branding"),
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
