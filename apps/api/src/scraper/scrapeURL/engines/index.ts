import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import type { BrowserCookie, Meta } from "..";
import { documentMaxReasonableTime, scrapeDocument } from "./document";
import {
  fireEngineMaxReasonableTime,
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEngineTLSClient,
} from "./fire-engine";
import { exchangeMaxReasonableTime, scrapeURLWithExchange } from "./exchange";
import { pdfMaxReasonableTime, scrapePDF } from "./pdf";
import { imageMaxReasonableTime, scrapeImage } from "./image";
import { fetchMaxReasonableTime, scrapeURLWithFetch } from "./fetch";
import {
  playwrightMaxReasonableTime,
  scrapeURLWithPlaywright,
} from "./playwright";
import { indexMaxReasonableTime, scrapeURLWithIndex } from "./index/index";
import {
  scrapeURLWithWikipedia,
  wikipediaMaxReasonableTime,
  isWikimediaUrl,
} from "./wikipedia";
import { useIndex } from "../../../services";
import { useFireEngine } from "./fire-engine/available";
import { hasFormatOfType } from "../../../lib/format-utils";
import {
  getPDFBlocks,
  getPDFPageMarkdown,
  getPDFPageMarkers,
  getPDFRefresh,
} from "../../../controllers/v2/types";
import type { PdfMetadata, PdfPageBlocks } from "./pdf/types";
import { BrandingProfile } from "../../../types/branding";
import {
  AgentIndexOnlyError,
  BrandingNotSupportedError,
  NoCachedDataError,
  UsOnlyUnavailableError,
} from "../error";
import { isUrlBlocked } from "../../WebScraper/utils/blocklist";
import { isUsOnly } from "../../../lib/us-only";
import { isXTwitterUrl } from "../../../lib/x-twitter-url";
import { hasCustomRequestContext } from "../lib/request-context";
import {
  getExchangeAccessForRequest,
  ThirdPartyDataTermsRequiredError,
  ThirdPartyDataUnsupportedOptionError,
  type ExchangeScrapeMetadata,
} from "../../../lib/exchange";
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

export { coreEngineFeatures };

export type Engine = EngineName;

export type FeatureFlag = EngineFeatureName;

export interface EngineScrapeResult {
  url: string;

  html: string;
  rawBase64?: string;
  markdown?: string;
  pages?: Array<{ pageNumber: number; markdown: string }>;
  blocks?: PdfPageBlocks[];
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

  branding?: BrandingProfile;
  /** First-screen screenshot taken for Jev's branding call; internal, never
   * returned (see the branding format's __experimental_screenshot and
   * BRANDING_JEV_SCREENSHOT_PERCENT). */
  brandingScreenshot?: string;

  pdfMetadata?: PdfMetadata;

  cacheInfo?: {
    created_at: Date;
  };

  contentType?: string;

  youtubeTranscriptContent?: any;
  postprocessorsUsed?: string[];
  warning?: string;
  audioCookies?: BrowserCookie[];

  proxyUsed: "basic" | "stealth";
  timezone?: string;
  exchange?: ExchangeScrapeMetadata;
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
  index: {
    enabled: () => useIndex,
    scrape: scrapeURLWithIndex,
    maxReasonableTime: indexMaxReasonableTime,
  },
  "index;documents": {
    enabled: () => useIndex,
    scrape: scrapeURLWithIndex,
    maxReasonableTime: indexMaxReasonableTime,
  },
  "fire-engine;chrome-cdp": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineChromeCDP,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  },
  "fire-engine;chrome-cdp;stealth": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineChromeCDP,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  },
  "fire-engine(retry);chrome-cdp": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineChromeCDP,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  },
  "fire-engine(retry);chrome-cdp;stealth": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineChromeCDP,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  },
  "fire-engine;tlsclient": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineTLSClient,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "tlsclient"),
  },
  "fire-engine;tlsclient;stealth": {
    enabled: () => useFireEngine,
    scrape: scrapeURLWithFireEngineTLSClient,
    maxReasonableTime: meta => fireEngineMaxReasonableTime(meta, "tlsclient"),
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
  // Image OCR needs FirePDF; without it the engine would only be a wasted
  // tail download on every failed scrape. Whether images are actually OCR'd
  // is decided where they are routed (lib/image-ocr-gate.ts), not here.
  image: {
    enabled: () => Boolean(config.FIRE_PDF_BASE_URL),
    scrape: scrapeImage,
    maxReasonableTime: imageMaxReasonableTime,
  },
  exchange: {
    enabled: () => Boolean(config.FIRE_EXCHANGE_URL),
    scrape: scrapeURLWithExchange,
    maxReasonableTime: exchangeMaxReasonableTime,
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

export function shouldUseIndex(meta: Meta) {
  if (meta.internalOptions.isParse) {
    return false;
  }

  // Skip index if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  return (
    useIndex &&
    config.FIRECRAWL_INDEX_WRITE_ONLY !== true &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    !hasFormatOfType(meta.options.formats, "branding") &&
    // The URL index does not yet persist physical-page or typed-block
    // capability metadata, and its markdown never carries page markers.
    !getPDFPageMarkdown(meta.options.parsers) &&
    !getPDFBlocks(meta.options.parsers) &&
    !getPDFPageMarkers(meta.options.parsers) &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    // A PDF refresh asks for a fresh parse; a URL index copy is the parse
    // being refreshed, so serving it would silently ignore the request.
    !(
      config.INDEX_SKIP_ON_PDF_REFRESH && getPDFRefresh(meta.options.parsers)
    ) &&
    !hasCustomRequestContext(meta.options)
  );
}

export async function buildFallbackList(meta: Meta): Promise<
  {
    engine: Engine;
    unsupportedFeatures: Set<FeatureFlag>;
  }[]
> {
  if (hasFormatOfType(meta.options.formats, "rawBase64")) {
    if (meta.internalOptions.agentIndexOnly) {
      throw new AgentIndexOnlyError();
    }

    if (meta.options.minAge !== undefined) {
      throw new NoCachedDataError();
    }

    if (meta.options.lockdown || (!useFireEngine && meta.mock === null)) {
      return [];
    }

    return [
      {
        engine: "fire-engine;chrome-cdp",
        unsupportedFeatures: new Set(),
      },
    ];
  }

  if (
    !meta.internalOptions.agentIndexOnly &&
    meta.internalOptions.forceEngine === undefined
  ) {
    const url = meta.rewrittenUrl ?? meta.url;
    const betaTeam =
      meta.internalOptions.teamFlags?.professionalProfileCompanyDataBeta ===
      true;
    let blocked = false;
    try {
      blocked = isUrlBlocked(url, meta.internalOptions.teamFlags ?? null, {
        team_id: meta.internalOptions.teamId ?? null,
        org_id: meta.internalOptions.orgId ?? null,
        origin: null,
        record: false,
      });
    } catch (error) {
      // Beta teams fail closed, as they always have. Anyone else keeps the
      // normal engines, since an unreadable blocklist must not fail every
      // scrape.
      if (betaTeam) {
        meta.logger.warn("Exchange blocklist check failed; failing closed", {
          error,
        });
        return [];
      }
    }

    // X posts and profiles only the Exchange serves, as blocked URLs (LinkedIn
    // profiles) are: a normal engine gets X's login wall. A profile or lockdown
    // scrape keeps the normal engines, as it did with Firecrawl's own X engine.
    const xTwitterPage =
      isXTwitterUrl(url) &&
      meta.options.profile === undefined &&
      !meta.options.lockdown;

    // They are answered by xAI, which is outside the US-only guarantee.
    if (xTwitterPage && isUsOnly(meta.internalOptions.teamFlags ?? undefined)) {
      throw new UsOnlyUnavailableError(
        "X/Twitter scraping is not available for teams restricted to US-only processing.",
      );
    }

    const exchangeAccess = await getExchangeAccessForRequest({
      url,
      teamId: meta.internalOptions.teamId ?? null,
      orgId: meta.internalOptions.orgId ?? null,
      blocked: blocked || xTwitterPage,
      origin: meta.internalOptions.origin ?? null,
      formats: meta.options.formats,
      actions: meta.options.actions,
      headers: meta.options.headers,
      waitFor: meta.options.waitFor,
      mobile: meta.options.mobile,
      location: meta.options.location,
      proxy: meta.options.proxy,
      blockAds: meta.options.blockAds,
      profile: meta.options.profile,
      atsv: meta.internalOptions.atsv,
      minAge: meta.options.minAge,
      includeTags: meta.options.includeTags,
      excludeTags: meta.options.excludeTags,
      zeroDataRetention: meta.internalOptions.zeroDataRetention,
      lockdown: meta.options.lockdown,
      redactPII: meta.options.redactPII,
      flags: meta.internalOptions.teamFlags ?? null,
    });
    if (exchangeAccess.allowed) {
      meta.exchangeProviderId = exchangeAccess.provider.id;
      return [
        {
          engine: "exchange",
          unsupportedFeatures: new Set(),
        },
      ];
    }

    // A blocked URL can only have been admitted (by scrapeBlocklistMiddleware
    // or batch scrape) for the Exchange; if it can no longer serve it (catalog
    // changed, service down), fail closed rather than letting normal engines
    // scrape a blocklisted site. X posts and profiles fail the same way.
    // Other URLs whose provider wants unaccepted terms or rejects an option
    // fall through and scrape normally.
    if (blocked || xTwitterPage) {
      if (exchangeAccess.termsRequired) {
        throw new ThirdPartyDataTermsRequiredError(exchangeAccess.terms);
      }
      if (exchangeAccess.unsupportedOption !== undefined) {
        throw new ThirdPartyDataUnsupportedOptionError(
          exchangeAccess.unsupportedOption,
        );
      }
      return [];
    }
  }

  const enabledEngines = service.engines
    .enabled()
    .filter(engine => !engine.explicitOnly)
    .map(engine => engine.name);
  const _engines: Engine[] = [
    ...enabledEngines,

    // enable fire-engine in self-hosted testing environment when mocks are supplied
    ...(!useFireEngine && meta.mock !== null
      ? (
          [
            "fire-engine;chrome-cdp",
            "fire-engine(retry);chrome-cdp",
            "fire-engine;chrome-cdp;stealth",
            "fire-engine(retry);chrome-cdp;stealth",
            // "fire-engine;tlsclient",
            // "fire-engine;tlsclient;stealth",
          ] as Engine[]
        ).filter(
          name =>
            !enabledEngines.includes(name) &&
            service.engines.get(name) !== undefined,
        )
      : []),
  ];

  if (meta.options.lockdown) {
    const indexEngines: Engine[] = useIndex ? ["index", "index;documents"] : [];
    _engines.length = 0;
    _engines.push(...indexEngines);
    meta.internalOptions.forceEngine = indexEngines;
  } else if (meta.internalOptions.agentIndexOnly) {
    // Index documents carry no physical-page or typed-block payloads, and
    // their markdown never carries page markers, so an index-only request
    // that demands them can only be answered wrong. Fail loud with the
    // canonical index-only error (maps to a clean 4xx and tells the caller
    // how to unlock live scraping) instead of silently serving a document
    // without the capability.
    if (
      getPDFPageMarkdown(meta.options.parsers) ||
      getPDFBlocks(meta.options.parsers) ||
      getPDFPageMarkers(meta.options.parsers) ||
      (config.INDEX_SKIP_ON_PDF_REFRESH && getPDFRefresh(meta.options.parsers))
    ) {
      meta.logger.warn(
        "agentIndexOnly request demands pageMarkdown/blocks/pageMarkers or a PDF refresh, which the URL index cannot serve",
        { parsers: meta.options.parsers },
      );
      throw new AgentIndexOnlyError();
    }
    const indexEngines: Engine[] = useIndex ? ["index", "index;documents"] : [];
    _engines.length = 0;
    _engines.push(...indexEngines);
    meta.internalOptions.forceEngine = indexEngines;
  } else if (!shouldUseIndex(meta)) {
    const indexIndex = _engines.indexOf("index");
    if (indexIndex !== -1) {
      _engines.splice(indexIndex, 1);
    }
    const indexDocumentsIndex = _engines.indexOf("index;documents");
    if (indexDocumentsIndex !== -1) {
      _engines.splice(indexDocumentsIndex, 1);
    }
  }

  // File-fetch routing: when fire-engine is available, PDF and document
  // downloads always go through the browser engines, which fetch the file
  // through fire-engine's proxy infrastructure and hand it back to this
  // waterfall via AddFeatureError (specialtyScrapeCheck) — the same route
  // the PDFAntibotError/PDFFetchProxyError and document-equivalent
  // recoveries have always taken, just taken immediately instead of after
  // a wasted direct download. The file engines (pdf, document, image)
  // then run as pure parsers on the prefetched file, and their own direct
  // undici downloads stay reachable only in self-hosted deployments (no
  // fire-engine) or under an explicit forceEngine pin.
  //
  // This is a bespoke list rather than a flag tweak because the pdf and
  // document flags (priority 100) exist precisely to keep every
  // non-file-capable engine out of the waterfall via the supportScore
  // threshold — the browser engines declare pdf/document: false, so they
  // can never qualify while the flag is set. Clearing the flag instead
  // would let fastMode/atsv requests admit tlsclient, which cannot hand
  // off files at all (the file download handler is chrome-cdp only) and
  // would burn prefetch round trips on null handoffs.
  const fileFetchFlag: FeatureFlag | null = meta.featureFlags.has("document")
    ? "document"
    : meta.featureFlags.has("pdf")
      ? "pdf"
      : meta.featureFlags.has("image")
        ? "image"
        : null;

  // A handoff of any file type ends the fetch leg: a .pdf URL can
  // legitimately serve a docx (and vice versa), so either prefetch being
  // set means the file is already in hand and the normal waterfall below
  // routes it to the right parser.
  if (
    useFireEngine &&
    fileFetchFlag !== null &&
    meta.pdfPrefetch === undefined &&
    meta.documentPrefetch === undefined &&
    meta.imagePrefetch === undefined &&
    // Lockdown and agentIndexOnly pin forceEngine above, so their
    // index-only semantics win; every other explicit pin is the escape
    // hatch that keeps the file engines' direct downloads working.
    meta.internalOptions.forceEngine === undefined
  ) {
    // Branding needs a rendered HTML page; preserve the historical
    // clean error (this early return would otherwise skip the check at
    // the bottom of this function).
    if (meta.featureFlags.has("branding")) {
      throw new BrandingNotSupportedError(
        fileFetchFlag === "pdf"
          ? "Branding extraction is only supported for HTML web pages. PDFs are not supported."
          : fileFetchFlag === "image"
            ? "Branding extraction is only supported for HTML web pages. Images are not supported."
            : "Branding extraction is only supported for HTML web pages. Documents (docx, xlsx, etc.) are not supported.",
      );
    }

    const browserEngines: Engine[] = meta.featureFlags.has("stealthProxy")
      ? // Explicit stealth: only the stealth variants can honor it. The
        // auto path escalates here on its own via AddFeatureError(["stealthProxy"]).
        [
          "fire-engine;chrome-cdp;stealth",
          "fire-engine(retry);chrome-cdp;stealth",
        ]
      : [
          "fire-engine;chrome-cdp",
          "fire-engine(retry);chrome-cdp",
          "fire-engine;chrome-cdp;stealth",
          "fire-engine(retry);chrome-cdp;stealth",
        ];

    const selectedEngines = [
      // Cache first: an index;documents hit serves the file without any
      // fetch at all. (Plain "index" is the same lookup, but the pdf
      // flag has always threshold-filtered it out for file URLs.)
      ...(shouldUseIndex(meta) ? (["index;documents"] as Engine[]) : []),
      ...browserEngines,
    ].map(engine => {
      const features = requireEngine(engine).features;
      const unsupportedFeatures = new Set<FeatureFlag>();
      for (const flag of meta.featureFlags) {
        if (!hasFeature(features, flag)) {
          unsupportedFeatures.add(flag);
        }
      }
      return { engine, unsupportedFeatures };
    });

    meta.logger.info("Selected engines", {
      selectedEngines,
      fileFetchRoute: fileFetchFlag,
    });

    return selectedEngines;
  }

  // When fire-engine is available, drop tlsclient and fetch from the general
  // waterfall: once chrome-cdp (and its retry) fail, degrading to a plain
  // HTTP client tends to produce bot-walled or otherwise low-quality content,
  // so we'd rather fail the scrape outright. They stay reachable when the
  // request asks for them: fastMode/atsv set feature flags that chrome-cdp
  // can't satisfy (and are handled here), audio/video keep tlsclient as the
  // avgrab fallback behind chrome-cdp, and forceEngine bypasses _engines
  // entirely, reading straight from internalOptions.
  if (
    useFireEngine &&
    !meta.featureFlags.has("useFastMode") &&
    !meta.featureFlags.has("atsv") &&
    !meta.featureFlags.has("audio") &&
    !meta.featureFlags.has("video")
  ) {
    for (const engine of [
      "fetch",
      "fire-engine;tlsclient",
      "fire-engine;tlsclient;stealth",
    ] as Engine[]) {
      const index = _engines.indexOf(engine);
      if (index !== -1) {
        _engines.splice(index, 1);
      }
    }
  }

  if (!isWikimediaUrl(meta.url) || Math.random() >= 0.5) {
    const wikiIndex = _engines.indexOf("wikipedia");
    if (wikiIndex !== -1) {
      _engines.splice(wikiIndex, 1);
    }
  }

  // Without fire-engine (or its test mocks), no engine fetches a page through
  // a stealth proxy: only index lookups and the file parsers declare
  // stealthProxy support. Counting the flag would leave only the file parsers
  // above the threshold and in the stealth-only narrowing below, so an HTML
  // page that escalated to stealthProxy would fail on every engine.
  const scoresStealthProxy = useFireEngine || meta.mock !== null;
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

  const currentEngines =
    meta.internalOptions.forceEngine !== undefined
      ? Array.isArray(meta.internalOptions.forceEngine)
        ? meta.internalOptions.forceEngine
        : [meta.internalOptions.forceEngine]
      : _engines;

  for (const engine of currentEngines) {
    // Zero data retention scrapes, forced engines included, never use the
    // Wikipedia engine: they stay on the engines that fetch the page directly.
    if (engine === "wikipedia" && meta.internalOptions.zeroDataRetention)
      continue;

    // A profile must never fall back to fetching anonymous content. File parsers
    // may consume bytes already fetched by the authenticated browser.
    if (
      meta.options.profile &&
      !engine.includes("chrome-cdp") &&
      !(engine === "pdf" && meta.pdfPrefetch) &&
      !(engine === "document" && meta.documentPrefetch) &&
      !(engine === "image" && meta.imagePrefetch)
    )
      continue;

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

  // When stealth proxy is explicitly requested (proxy: "stealth" | "enhanced"),
  // restrict the fallback list to engines that actually support it. Stealth
  // engines all carry negative quality, so without this the quality filter
  // below would drop them in favor of a regular positive-quality engine,
  // silently ignoring the user's request and never attempting stealth.
  // The guard keeps the original list if no stealth-capable engine qualified
  // (e.g. self-hosted without fire-engine) so scrapes don't break entirely.
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
      x => requireEngine(x.engine).quality > 0 && !x.engine.startsWith("index"),
    )
  ) {
    selectedEngines = selectedEngines.filter(
      x => requireEngine(x.engine).quality > 0,
    );
  }

  if (meta.internalOptions.forceEngine === undefined) {
    // retain force engine order
    // THIS SUCKS BUT IT WORKS
    selectedEngines.sort(
      (a, b) =>
        b.supportScore - a.supportScore ||
        requireEngine(b.engine).quality - requireEngine(a.engine).quality,
    );
  }

  meta.logger.info("Selected engines", {
    selectedEngines,
  });

  if (meta.featureFlags.has("branding")) {
    const hasCDPEngine = selectedEngines.some(
      f => !f.unsupportedFeatures.has("branding"),
    );
    if (!hasCDPEngine) {
      if (meta.featureFlags.has("pdf")) {
        throw new BrandingNotSupportedError(
          "Branding extraction is only supported for HTML web pages. PDFs are not supported.",
        );
      } else if (meta.featureFlags.has("document")) {
        throw new BrandingNotSupportedError(
          "Branding extraction is only supported for HTML web pages. Documents (docx, xlsx, etc.) are not supported.",
        );
      }
      throw new BrandingNotSupportedError(
        "Branding extraction requires Chrome CDP (fire-engine).",
      );
    }
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
  if (
    hasFeature(registered.features, "stealthProxy") &&
    !engine.startsWith("index") // don't force stealth proxy for index
  ) {
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
