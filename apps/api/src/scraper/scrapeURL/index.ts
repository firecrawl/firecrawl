import {
  Document,
  getPDFMaxPages,
  ScrapeOptions,
} from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { TransportableError } from "../../lib/error";
import { hasFormatOfType } from "../../lib/format-utils";
import { AbortManagerThrownError } from "./lib/abortManager";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import { setSpanAttributes, withSpan } from "../../lib/otel-tracer";
import { useIndex } from "../../services/index";
import {
  mainEngine,
  resolveSpecialEngineFromURL,
  shouldUseIndex,
} from "./engines";
import { indexEngine } from "./engines/index/index";
import { Engine, EngineScrapeResult } from "./engines/types";
import {
  AgentIndexOnlyError,
  IndexMissError,
  LockdownMissError,
  ReliableRetrievalError,
} from "./error";
import { FeatureFlag } from "./lib/feature-flags";
import { InternalOptions } from "./lib/internal-options";
import { buildMetaObject, Meta } from "./lib/meta";
import { doRobotsCheckIfNeeded } from "./lib/robots";
import { parseEngineResult } from "./parsers";
import { executeTransformers } from "./transformers";

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

export type { InternalOptions } from "./lib/internal-options";
export type { Meta } from "./lib/meta";

type EngineRun = {
  engine: Engine;
  result: EngineScrapeResult;
  unsupportedFeatures: Set<FeatureFlag>;
  indexAttempted: boolean;
};

function withProxy(meta: Meta, proxy: "basic" | "enhanced"): Meta {
  return {
    ...meta,
    options: {
      ...meta.options,
      proxy,
    },
  };
}

function unsupportedFeaturesFor(meta: Meta, engine: Engine): Set<FeatureFlag> {
  const unsupported = new Set<FeatureFlag>();
  for (const flag of meta.featureFlags) {
    if (!engine.features[flag]) {
      unsupported.add(flag);
    }
  }
  return unsupported;
}

function appendDocumentWarning(document: Document, warning: string) {
  document.warning =
    document.warning !== undefined ? document.warning + " " + warning : warning;
}

async function tryIndex(meta: Meta): Promise<EngineRun | null> {
  const indexAttempted =
    meta.options.lockdown ||
    meta.internalOptions.agentIndexOnly ||
    shouldUseIndex(meta);

  if (!indexAttempted) {
    return null;
  }

  try {
    const result = await indexEngine.scrape(meta);
    return {
      engine: indexEngine,
      result,
      unsupportedFeatures: unsupportedFeaturesFor(meta, indexEngine),
      indexAttempted: true,
    };
  } catch (error) {
    if (!(error instanceof IndexMissError)) {
      throw error;
    }

    if (meta.options.lockdown) {
      throw new LockdownMissError();
    }

    if (meta.internalOptions.agentIndexOnly) {
      throw new AgentIndexOnlyError();
    }

    return null;
  }
}

async function runNetworkEngine(
  meta: Meta,
  indexAttempted: boolean,
): Promise<EngineRun> {
  const url = meta.rewrittenUrl ?? meta.url;
  const proxy = meta.options.proxy === "auto" ? "basic" : meta.options.proxy;
  const proxyMeta = withProxy(meta, proxy);
  const specialEngine = resolveSpecialEngineFromURL(url);

  if (specialEngine) {
    const result = await specialEngine.scrape(proxyMeta);
    return {
      engine: specialEngine,
      result,
      unsupportedFeatures: unsupportedFeaturesFor(meta, specialEngine),
      indexAttempted,
    };
  }

  try {
    const result = await mainEngine.scrape(proxyMeta);
    return {
      engine: mainEngine,
      result,
      unsupportedFeatures: unsupportedFeaturesFor(meta, mainEngine),
      indexAttempted,
    };
  } catch (error) {
    if (
      error instanceof ReliableRetrievalError &&
      meta.options.proxy === "auto"
    ) {
      meta.logger.info("Retrying main engine with enhanced proxy", {
        engine: mainEngine.name,
      });
      const result = await mainEngine.scrape(withProxy(meta, "enhanced"));
      return {
        engine: mainEngine,
        result,
        unsupportedFeatures: unsupportedFeaturesFor(meta, mainEngine),
        indexAttempted,
      };
    }

    throw error;
  }
}

function applyRunMetadata(
  meta: Meta,
  run: EngineRun,
  document: Document,
): Document {
  if (run.indexAttempted) {
    if (run.result.cacheInfo) {
      document.metadata.cacheState = "hit";
      document.metadata.cachedAt =
        run.result.cacheInfo.created_at.toISOString();
    } else {
      document.metadata.cacheState = "miss";
    }
  }

  for (const warning of meta.warnings ?? []) {
    appendDocumentWarning(document, warning);
  }

  if (run.unsupportedFeatures.size > 0) {
    const warning = `The engine used does not support the following features: ${[
      ...run.unsupportedFeatures,
    ].join(", ")} -- your scrape may be partial.`;
    meta.logger.warn(warning, {
      engine: run.engine.name,
      unsupportedFeatures: run.unsupportedFeatures,
    });
    appendDocumentWarning(document, warning);
  }

  return document;
}

async function runScrape(meta: Meta): Promise<ScrapeUrlResponse> {
  return withSpan("scrape.engine", async span => {
    meta.logger.info(
      `Scraping URL ${JSON.stringify(meta.rewrittenUrl ?? meta.url)}...`,
    );

    setSpanAttributes(span, {
      "engine.url": meta.rewrittenUrl ?? meta.url,
      "engine.features": Array.from(meta.featureFlags).join(","),
    });

    const indexRun = await tryIndex(meta);
    const run =
      indexRun ?? (await runNetworkEngine(meta, shouldUseIndex(meta)));

    setSpanAttributes(span, {
      "engine.winner": run.engine.name,
      "engine.unsupported_features":
        run.unsupportedFeatures.size > 0
          ? Array.from(run.unsupportedFeatures).join(",")
          : undefined,
    });

    meta.winnerEngine = run.engine.name;
    meta.audioCookies = run.result.audioCookies;

    let document = await parseEngineResult(meta, run.result);
    document = applyRunMetadata(meta, run, document);
    document = await executeTransformers(meta, document);

    setSpanAttributes(span, {
      "engine.final_status_code": document.metadata.statusCode,
      "engine.final_url": document.metadata.url,
      "engine.content_type": document.metadata.contentType,
      "engine.proxy_used": document.metadata.proxyUsed,
      "engine.cache_state": document.metadata.cacheState,
      "engine.postprocessors_used":
        document.metadata.postprocessorsUsed?.join(","),
    });

    return {
      success: true,
      document,
      unsupportedFeatures: run.unsupportedFeatures,
    };
  });
}

function logScrapeMetrics(
  meta: Meta,
  startTime: number,
  result: ScrapeUrlResponse,
) {
  meta.logger.debug("scrapeURL metrics", {
    module: "scrapeURL/metrics",
    timeTaken: Date.now() - startTime,
    maxAgeValid: (meta.options.maxAge ?? 0) > 0,
    shouldUseIndex: shouldUseIndex(meta),
    success: result.success,
    indexHit: result.success && result.document.metadata.cacheState === "hit",
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
      screenshotEnabled: !!hasFormatOfType(meta.options.formats, "screenshot"),
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
      indexHit: result.success && result.document.metadata.cacheState === "hit",
    });
  }
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

    try {
      setSpanAttributes(span, {
        "scrape.id": id,
        "scrape.url": url,
        "scrape.team_id": internalOptions.teamId,
        "scrape.crawl_id": internalOptions.crawlId,
        "scrape.zero_data_retention": internalOptions.zeroDataRetention,
        "scrape.features": Array.from(meta.featureFlags).join(","),
      });

      meta.logger.info("scrapeURL entered");

      if (meta.rewrittenUrl) {
        meta.logger.info("Rewriting URL", { rewrittenUrl: meta.rewrittenUrl });
        setSpanAttributes(span, {
          "scrape.rewritten_url": meta.rewrittenUrl,
        });
      }

      if (internalOptions.isPreCrawl === true) {
        setSpanAttributes(span, {
          "scrape.is_precrawl": true,
        });
      }

      await doRobotsCheckIfNeeded(meta, span);

      const result = await runScrape(meta);
      logScrapeMetrics(meta, startTime, result);

      setSpanAttributes(span, {
        "scrape.success": true,
        "scrape.duration_ms": Date.now() - startTime,
        "scrape.index_hit":
          result.success && result.document.metadata.cacheState === "hit",
      });

      return result;
    } catch (error) {
      if (error instanceof AbortManagerThrownError) {
        throw error.inner;
      }

      const result: ScrapeUrlResponse = {
        success: false,
        error,
      };
      logScrapeMetrics(meta, startTime, result);

      if (!(error instanceof TransportableError)) {
        captureExceptionWithZdrCheck(error, {
          extra: {
            zeroDataRetention: internalOptions.zeroDataRetention ?? false,
          },
        });
      }

      meta.logger.warn("scrapeURL: Scrape failed", { error });

      setSpanAttributes(span, {
        "scrape.success": false,
        "scrape.error": error instanceof Error ? error.message : String(error),
        "scrape.error_type":
          error instanceof TransportableError ? error.code : "unknown",
        "scrape.duration_ms": Date.now() - startTime,
      });

      return result;
    } finally {
      if (meta.abortHandle) {
        clearTimeout(meta.abortHandle);
      }
    }
  });
}
