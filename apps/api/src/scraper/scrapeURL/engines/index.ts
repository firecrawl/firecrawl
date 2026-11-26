import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import type { BrowserCookie, Meta } from "..";
import { documentMaxReasonableTime, scrapeDocument } from "./document";
import { pdfMaxReasonableTime, scrapePDF } from "./pdf";
import { fetchMaxReasonableTime, scrapeURLWithFetch } from "./fetch";
import {
  playwrightMaxReasonableTime,
  scrapeURLWithPlaywright,
} from "./playwright";
import {
  scrapeURLWithWikipedia,
  wikipediaMaxReasonableTime,
  isWikimediaUrl,
} from "./wikipedia";
import { hasFormatOfType } from "../../../lib/format-utils";
import type { PdfMetadata } from "./pdf/types";
import { AgentIndexOnlyError, NoCachedDataError } from "../error";
import { hasCustomRequestContext } from "../lib/request-context";
import { service } from "../../../service";
import type {
  Engine as RegisteredEngine,
  EngineFeatureName,
  EngineName,
} from "../../../service/engines";
import {
  coreEngineFeatures,
  coreEngineSpecs,
  type CoreEngineName,
} from "./metadata";
import { scrapeHooks, toScrapeMeta } from "../hooks";

export { coreEngineFeatures };

export type Engine = EngineName;

export type FeatureFlag = EngineFeatureName;

export interface EngineScrapeResult {
  url: string;

  html: string;
  rawBase64?: string;
  markdown?: string;
  statusCode: number;
  error?: string;

  screenshot?: string;
  actions?: {
    screenshots: string[];
    scrapes: ScrapeActionContent[];
    javascriptReturns: {
      type: string;
      value: unknown;
    }[];
    pdfs: string[];
  };

  pdfMetadata?: PdfMetadata;

  cacheInfo?: {
    created_at: Date;
  };

  contentType?: string;

  postprocessorsUsed?: string[];
  warning?: string;

  proxyUsed: "basic" | "stealth";
  timezone?: string;
  exchange?: Record<string, unknown>;
}

const coreEngineRuntime: Record<
  CoreEngineName,
  {
    enabled: () => boolean;
    scrape: (meta: Meta) => Promise<EngineScrapeResult>;
    maxReasonableTime: (meta: Meta) => number;
  }
> = {
  wikipedia: {
    enabled: () =>
      config.WIKIPEDIA_ENTERPRISE_USERNAME !== undefined &&
      config.WIKIPEDIA_ENTERPRISE_USERNAME !== "" &&
      config.WIKIPEDIA_ENTERPRISE_PASSWORD !== undefined &&
      config.WIKIPEDIA_ENTERPRISE_PASSWORD !== "",
    scrape: scrapeURLWithWikipedia,
    maxReasonableTime: wikipediaMaxReasonableTime,
  },
  playwright: {
    enabled: () =>
      config.PLAYWRIGHT_MICROSERVICE_URL !== "" &&
      config.PLAYWRIGHT_MICROSERVICE_URL !== undefined,
    scrape: scrapeURLWithPlaywright,
    maxReasonableTime: playwrightMaxReasonableTime,
  },
  fetch: {
    enabled: () => true,
    scrape: scrapeURLWithFetch,
    maxReasonableTime: fetchMaxReasonableTime,
  },
  pdf: {
    enabled: () => true,
    scrape: scrapePDF,
    maxReasonableTime: pdfMaxReasonableTime,
  },
  document: {
    enabled: () => true,
    scrape: scrapeDocument,
    maxReasonableTime: documentMaxReasonableTime,
  },
};

/** Built-in scrape engine registrations, in default fallback tie-break order. */
export const coreEngines: readonly RegisteredEngine[] = coreEngineSpecs.map(
  spec => {
    const runtime = coreEngineRuntime[spec.name];
    return {
      name: spec.name,
      quality: spec.quality,
      features: spec.features,
      ...(spec.explicitOnly ? { explicitOnly: true } : {}),
      ...(spec.cache ? { cache: true } : {}),
      ...(spec.fileOnly ? { fileOnly: true } : {}),
      ...(spec.supportsProfile ? { supportsProfile: true } : {}),
      ...(spec.prefetchesFiles ? { prefetchesFiles: true } : {}),
      ...(spec.allowEmptyContent ? { allowEmptyContent: true } : {}),
      enabled: runtime.enabled,
      scrape: runtime.scrape,
      maxReasonableTime: runtime.maxReasonableTime,
    };
  },
);

const hasFeature = (
  features: RegisteredEngine["features"],
  flag: FeatureFlag,
): boolean => Object.hasOwn(features, flag) && features[flag] === true;

const isFileOnlyEngine = (registered: RegisteredEngine): boolean =>
  registered.fileOnly === true;

function shouldAllowCacheEngines(meta: Meta): boolean {
  if (meta.internalOptions.isParse) {
    return false;
  }

  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  const extOptions = meta.options as Meta["options"] & {
    maxAge?: number;
    profile?: unknown;
  };
  return (
    !hasCustomScreenshotSettings &&
    extOptions.maxAge !== 0 &&
    !hasCustomRequestContext(extOptions)
  );
}

const requireEngine = (engine: Engine): RegisteredEngine => {
  const registered = service.engines.get(engine);
  if (!registered) {
    throw new Error(`Engine "${engine}" is not registered on the service`);
  }
  return registered;
};

const getFeaturePriority = (flag: FeatureFlag): number => {
  const feature = service.engines.feature(flag);
  if (feature === undefined) {
    throw new Error(
      `Engine feature "${flag}" is not registered on the service`,
    );
  }
  return feature.priority;
};

function isEngineAllowedByPolicy(meta: Meta, engine: Engine): boolean {
  // Zero data retention scrapes never use the Wikipedia engine: they stay on
  // the engines that fetch the page directly.
  if (engine === "wikipedia" && meta.internalOptions.zeroDataRetention) {
    return false;
  }

  const registered = service.engines.get(engine);

  const extOptions = meta.options as Meta["options"] & {
    profile?: unknown;
    lockdown?: boolean;
  };
  // A profile must never fall back to fetching anonymous content. File parsers
  // may consume bytes already fetched by the authenticated browser.
  if (
    extOptions.profile &&
    !registered?.supportsProfile &&
    !(engine === "pdf" && meta.pdfPrefetch) &&
    !(engine === "document" && meta.documentPrefetch) &&
    !(
      registered !== undefined &&
      !registered.cache &&
      hasFeature(registered.features, "image") &&
      meta.imagePrefetch
    )
  ) {
    return false;
  }

  if (
    (extOptions.lockdown || meta.internalOptions.agentIndexOnly) &&
    !registered?.cache
  ) {
    return false;
  }

  return true;
}

export type FallbackEngineEntry = {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
};

export function resolveCandidateEngines(
  meta: Meta,
  candidates: readonly Engine[],
  existing: ReadonlyMap<Engine, FallbackEngineEntry>,
  options?: { suppressUnsupportedWarnings?: boolean },
): FallbackEngineEntry[] {
  const suppressUnsupportedWarnings =
    options?.suppressUnsupportedWarnings === true;
  const resolved: FallbackEngineEntry[] = [];
  for (const engine of new Set(candidates)) {
    if (!isEngineAllowedByPolicy(meta, engine)) {
      continue;
    }
    const prior = existing.get(engine);
    if (prior) {
      resolved.push(
        suppressUnsupportedWarnings
          ? { engine, unsupportedFeatures: new Set() }
          : prior,
      );
      continue;
    }
    const registered = service.engines.get(engine);
    if (!registered) {
      meta.logger.warn("Skipping unregistered engine", { engine });
      continue;
    }
    if (!registered.enabled() && meta.mock === null) {
      continue;
    }
    const unsupportedFeatures = new Set<FeatureFlag>();
    if (!suppressUnsupportedWarnings) {
      for (const flag of meta.featureFlags) {
        if (!hasFeature(registered.features, flag)) {
          unsupportedFeatures.add(flag);
        }
      }
    }
    resolved.push({ engine, unsupportedFeatures });
  }
  return resolved;
}

export async function buildFallbackList(
  meta: Meta,
): Promise<FallbackEngineEntry[]> {
  let selected = await selectFallbackList(meta);
  const hooks = scrapeHooks();
  if (hooks?.has("scrape.engines.select")) {
    const plan = await hooks.transform(
      "scrape.engines.select",
      { candidates: selected.map(x => x.engine) },
      toScrapeMeta(meta),
    );
    const byEngine = new Map(selected.map(x => [x.engine, x]));
    selected = resolveCandidateEngines(meta, plan.candidates, byEngine, {
      suppressUnsupportedWarnings: plan.suppressUnsupportedWarnings,
    });
  }

  meta.logger.info("Selected engines", {
    selectedEngines: selected,
  });

  return selected;
}

async function selectFallbackList(meta: Meta): Promise<FallbackEngineEntry[]> {
  const extOptions = meta.options as Meta["options"] & {
    minAge?: number;
    lockdown?: boolean;
  };
  if (hasFormatOfType(meta.options.formats, "rawBase64")) {
    if (meta.internalOptions.agentIndexOnly) {
      throw new AgentIndexOnlyError();
    }

    if (extOptions.minAge !== undefined) {
      throw new NoCachedDataError();
    }

    return [];
  }

  const enabled = service.engines.enabled();
  const _engines: Engine[] = enabled
    .filter(engine => !engine.explicitOnly)
    .map(engine => engine.name);
  const cacheEngines: Engine[] = enabled
    .filter(engine => engine.cache === true)
    .map(engine => engine.name);

  if (extOptions.lockdown) {
    _engines.length = 0;
    _engines.push(...cacheEngines);
    meta.internalOptions.forceEngine = cacheEngines;
  } else if (meta.internalOptions.agentIndexOnly) {
    _engines.length = 0;
    _engines.push(...cacheEngines);
    meta.internalOptions.forceEngine = cacheEngines;
  } else if (!shouldAllowCacheEngines(meta)) {
    for (let i = _engines.length - 1; i >= 0; i--) {
      if (service.engines.get(_engines[i])?.cache === true) {
        _engines.splice(i, 1);
      }
    }
  }

  if (!isWikimediaUrl(meta.rewrittenUrl ?? meta.url)) {
    const wikiIndex = _engines.indexOf("wikipedia");
    if (wikiIndex !== -1) {
      _engines.splice(wikiIndex, 1);
    }
  }

  const currentEngines =
    meta.internalOptions.forceEngine !== undefined
      ? Array.isArray(meta.internalOptions.forceEngine)
        ? meta.internalOptions.forceEngine
        : [meta.internalOptions.forceEngine]
      : _engines;

  // Score stealthProxy only when at least one non-cache, non-file candidate
  // engine actually fetches pages through a stealth proxy. Otherwise counting
  // the flag would narrow an HTML scrape down to file parsers.
  const scoresStealthProxy = currentEngines.some(engine => {
    const registered = service.engines.get(engine);
    return (
      registered !== undefined &&
      hasFeature(registered.features, "stealthProxy") &&
      !registered.cache &&
      !isFileOnlyEngine(registered)
    );
  });
  const isScoredFlag = (flag: FeatureFlag) =>
    scoresStealthProxy || flag !== "stealthProxy";

  const prioritySum = [...meta.featureFlags]
    .filter(isScoredFlag)
    .reduce((a, x) => a + getFeaturePriority(x), 0);
  const priorityThreshold = Math.floor(prioritySum / 2);
  let selectedEngines: {
    engine: Engine;
    supportScore: number;
    unsupportedFeatures: Set<FeatureFlag>;
  }[] = [];

  for (const engine of currentEngines) {
    if (!isEngineAllowedByPolicy(meta, engine)) continue;

    const registered = service.engines.get(engine);
    if (!registered) {
      meta.logger.warn("Skipping unregistered engine", { engine });
      continue;
    }

    const supportedFlags: FeatureFlag[] = [];
    const unsupportedFeatures = new Set<FeatureFlag>();
    for (const flag of meta.featureFlags) {
      if (hasFeature(registered.features, flag)) {
        supportedFlags.push(flag);
      } else {
        unsupportedFeatures.add(flag);
      }
    }

    const supportScore = supportedFlags
      .filter(isScoredFlag)
      .reduce((a, x) => a + getFeaturePriority(x), 0);

    if (supportScore >= priorityThreshold) {
      selectedEngines.push({ engine, supportScore, unsupportedFeatures });
    }
  }

  if (scoresStealthProxy && meta.featureFlags.has("stealthProxy")) {
    const stealthCapable = selectedEngines.filter(
      x => !x.unsupportedFeatures.has("stealthProxy"),
    );
    if (stealthCapable.length > 0) {
      selectedEngines = stealthCapable;
    }
  }

  if (
    selectedEngines.some(
      x =>
        requireEngine(x.engine).quality > 0 && !requireEngine(x.engine).cache,
    )
  ) {
    selectedEngines = selectedEngines.filter(
      x => requireEngine(x.engine).quality > 0,
    );
  }

  if (meta.internalOptions.forceEngine === undefined) {
    selectedEngines.sort(
      (a, b) =>
        b.supportScore - a.supportScore ||
        requireEngine(b.engine).quality - requireEngine(a.engine).quality,
    );
  }

  return selectedEngines;
}

export async function scrapeURLWithEngine(
  meta: Meta,
  engine: Engine,
): Promise<EngineScrapeResult> {
  const registered = requireEngine(engine);
  const fn = registered.scrape;
  const logger = meta.logger.child({
    method: fn.name || "scrapeURLWithEngine",
    engine,
  });

  const featureFlags = new Set(meta.featureFlags);
  if (hasFeature(registered.features, "stealthProxy") && !registered.cache) {
    featureFlags.add("stealthProxy");
  }

  const _meta = {
    ...meta,
    logger,
    featureFlags,
  };

  return await fn(_meta);
}

export function getEngineMaxReasonableTime(meta: Meta, engine: Engine): number {
  const mrt = service.engines.get(engine)?.maxReasonableTime;
  // shan't happen - mogery
  if (mrt === undefined) {
    meta.logger.warn("No MRT for engine", { engine });
    return 30000;
  }
  return mrt(meta);
}
