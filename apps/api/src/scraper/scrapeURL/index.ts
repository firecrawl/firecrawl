import type { ScrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import {
  fetchRobotsTxt,
  createRobotsChecker,
  isUrlAllowedByRobots,
} from "../../lib/robots-txt";
import { getCrawl } from "../../lib/crawl-redis";
import { ActionsNotSupportedError, CrawlDenialError } from "../../lib/error";
import { config } from "../../config";

import {
  buildMeta,
  hasFeature,
  activeFeatures,
  type Meta,
  type InternalOptions,
} from "./context";
import type { Engine, EngineScrapeResult, Fetched } from "./types";
import {
  IndexMissError,
  LockdownMissError,
  ZDRViolationError,
  ProxySelectionError,
} from "./error";
import {
  buildDocument,
  runDerive,
  runEnrich,
  runEmit,
  handleScrapeError,
  logScrapeMetrics,
  shouldUseIndex,
  type ScrapeUrlResponse,
} from "./pipeline";
import { shapeForFormats } from "./shape";
import {
  fetchProxy,
  fetchViaGateway,
  fetchViaCdp,
  fetchViaPlaywright,
} from "./fetch/network";
import { scrapeURLWithWikipedia, isWikimediaUrl } from "./fetch/wikipedia";
import { scrapeURLWithIndex } from "./fetch/cache-lookup";
import { parsePdfBuffer } from "./parse/pdf";
import { parseDocumentBuffer } from "./parse/document";
import { isPdf } from "./parse/pdf/pdf-utils";
import { isDocument, htmlNeedsJs, toHtmlResult } from "./parse/classify";
import { shouldRunYoutube, runYoutube } from "./parse/youtube";

export type { Meta, InternalOptions, ScrapeUrlResponse };
export { scrapeFile } from "./scrape-file";

export async function scrapeURL(
  id: string,
  url: string,
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
      "scrape.crawl_id": internalOptions.crawlId,
      "scrape.zero_data_retention": internalOptions.zeroDataRetention,
      "scrape.features": Array.from(activeFeatures(meta)).join(","),
      ...(meta.url !== url ? { "scrape.rewritten_url": meta.url } : {}),
      ...(internalOptions.isPreCrawl ? { "scrape.is_precrawl": true } : {}),
    });

    meta.logger.info("scrapeURL entered");
    if (meta.url !== url) meta.logger.info("Rewriting URL");

    try {
      if (internalOptions.teamFlags?.checkRobotsOnScrape && !options.lockdown) {
        const denial = await checkRobots(meta);
        if (denial) return denial;
      }

      const { result, engine } = await runPipeline(meta);
      setSpanAttributes(span, { "scrape.engine": engine });

      const processed = await runPostprocessors(meta, result);
      let document = buildDocument(meta, processed, engine);

      document = await runDerive(meta, document);
      document = await runEnrich(meta, document);
      await runEmit(meta, document, engine);
      document = shapeForFormats(meta, document);

      setSpanAttributes(span, {
        "scrape.final_status_code": document.metadata.statusCode,
        "scrape.final_url": document.metadata.url,
        "scrape.content_type": document.metadata.contentType,
        "scrape.proxy_used": document.metadata.proxyUsed,
        "scrape.cache_state": document.metadata.cacheState,
        "scrape.postprocessors_used": processed.postprocessorsUsed?.join(","),
        "scrape.success": true,
        "scrape.duration_ms": Date.now() - startTime,
        "scrape.index_hit": document.metadata.cacheState === "hit",
      });
      logScrapeMetrics(
        meta,
        startTime,
        true,
        document.metadata.cacheState === "hit",
      );

      return { success: true, document, unsupportedFeatures: new Set() };
    } catch (error) {
      logScrapeMetrics(meta, startTime, false, false);
      return handleScrapeError(meta, error, startTime, span, internalOptions);
    } finally {
      meta.abort.dispose();
    }
  });
}

async function runPipeline(meta: Meta): Promise<{
  result: EngineScrapeResult;
  engine: Engine;
}> {
  meta.logger.info(`Scraping URL ${JSON.stringify(meta.url)}...`);
  meta.abort.throwIfAborted();

  if (isWikimediaUrl(meta.url)) {
    return { result: await scrapeURLWithWikipedia(meta), engine: "wikipedia" };
  }

  enforceZdrLimits(meta);

  if (shouldUseIndex(meta) || meta.internalOptions.agentIndexOnly) {
    try {
      return { result: await scrapeURLWithIndex(meta), engine: "index" };
    } catch (error) {
      if (!(error instanceof IndexMissError)) throw error;
      if (meta.options.lockdown) throw new LockdownMissError();
      meta.logger.debug("Index miss - falling through to live fetch");
    }
  } else if (meta.options.lockdown) {
    // Lockdown forbids live fetch: if the index wasn't even eligible, miss.
    throw new LockdownMissError();
  }

  const hasFireEngine = !!config.FIRE_ENGINE_BETA_URL;
  const hasPlaywright = !!config.PLAYWRIGHT_MICROSERVICE_URL;

  if (!hasFireEngine && hasFeature(meta, "actions")) {
    throw new ActionsNotSupportedError(
      "Actions are not supported without fire-engine configured.",
    );
  }

  let fetched: Fetched;
  if (hasFireEngine) {
    const proxy = await fetchProxy(
      hasFeature(meta, "stealthProxy") ? "mobile" : "basic",
      meta.options.location?.country,
      meta.logger,
      meta.abort.asSignal(),
    );

    fetched =
      config.FIRE_ENGINE_HTTP_GATEWAY_URL && proxy
        ? await fetchViaGateway(meta, proxy).catch(error => {
            meta.logger.warn("gateway failed, falling back to cdp", { error });
            return fetchViaCdp(meta, { proxy });
          })
        : await fetchViaCdp(meta, { proxy });

    if (fetched.via === "gateway" && htmlNeedsJs(fetched)) {
      fetched = await fetchViaCdp(meta, { prefetch: fetched, proxy });
    }
  } else if (hasPlaywright) {
    fetched = await fetchViaPlaywright(meta);
  } else {
    throw new Error(
      "No scrape engine configured (set FIRE_ENGINE_BETA_URL or PLAYWRIGHT_MICROSERVICE_URL).",
    );
  }

  if (isPdf(fetched)) {
    return { result: await parsePdfBuffer(meta, fetched), engine: "pdf" };
  }
  if (isDocument(fetched)) {
    return {
      result: await parseDocumentBuffer(meta, fetched),
      engine: "document",
    };
  }
  return {
    result: toHtmlResult(fetched),
    engine: fetched.via,
  };
}

function enforceZdrLimits(meta: Meta): void {
  if (!meta.internalOptions.zeroDataRetention) return;
  if (hasFeature(meta, "screenshot")) throw new ZDRViolationError("screenshot");
  if (hasFeature(meta, "screenshot@fullScreen")) {
    throw new ZDRViolationError("screenshot@fullScreen");
  }
  if (meta.options.actions?.some(x => x.type === "screenshot")) {
    throw new ZDRViolationError("screenshot action");
  }
  if (meta.options.actions?.some(x => x.type === "pdf")) {
    throw new ZDRViolationError("pdf action");
  }
}

async function runPostprocessors(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<EngineScrapeResult> {
  meta.audioCookies = engineResult.audioCookies;

  if (
    !shouldRunYoutube(
      new URL(engineResult.url),
      engineResult.postprocessorsUsed,
    )
  ) {
    return engineResult;
  }
  meta.logger.info("Running postprocessor youtube");
  try {
    return await runYoutube(
      {
        ...meta,
        logger: meta.logger.child({ method: "postprocessors/youtube" }),
      },
      engineResult,
    );
  } catch (error) {
    meta.logger.warn("Failed to run postprocessor youtube", { error });
    return engineResult;
  }
}

async function checkRobots(meta: Meta): Promise<ScrapeUrlResponse | undefined> {
  const urlToCheck = meta.url;
  meta.logger.info("Checking robots.txt", { url: urlToCheck });

  try {
    return await withSpan("scrape.robots_check", async robotsSpan => {
      const isRobotsTxtPath = new URL(urlToCheck).pathname === "/robots.txt";
      setSpanAttributes(robotsSpan, {
        "robots.url": urlToCheck,
        "robots.is_robots_txt_path": isRobotsTxtPath,
      });
      if (isRobotsTxtPath) return undefined;

      try {
        let robotsTxt: string | undefined;
        if (meta.internalOptions.crawlId) {
          robotsTxt = (await getCrawl(meta.internalOptions.crawlId))?.robots;
        }
        if (!robotsTxt) {
          const { content } = await fetchRobotsTxt(
            {
              url: urlToCheck,
              zeroDataRetention:
                meta.internalOptions.zeroDataRetention || false,
              location: meta.options.location,
            },
            meta.id,
            meta.logger,
            meta.abort.asSignal(),
          );
          robotsTxt = content;
        }
        const checker = createRobotsChecker(urlToCheck, robotsTxt);
        const allowed = isUrlAllowedByRobots(urlToCheck, checker.robots);
        setSpanAttributes(robotsSpan, { "robots.allowed": allowed });
        if (!allowed) {
          meta.logger.info("URL blocked by robots.txt", { url: urlToCheck });
          throw new CrawlDenialError("URL blocked by robots.txt");
        }
      } catch (error) {
        if (error instanceof CrawlDenialError) throw error;
        meta.logger.debug("Failed to fetch robots.txt, allowing scrape", {
          error,
          url: urlToCheck,
        });
        setSpanAttributes(robotsSpan, { "robots.fetch_failed": true });
      }
      return undefined;
    });
  } catch (error) {
    if (error instanceof CrawlDenialError) {
      return { success: false, error };
    }
    throw error;
  }
}
