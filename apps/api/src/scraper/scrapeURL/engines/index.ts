import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import type { BrowserCookie, Meta } from "..";
import { documentMaxReasonableTime, scrapeDocument } from "./document";
import {
  fireEngineMaxReasonableTime,
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEngineTLSClient,
} from "./fire-engine";
import {
  exchangeMaxReasonableTime,
  scrapeURLWithExchange,
} from "./exchange";
import { pdfMaxReasonableTime, scrapePDF } from "./pdf";
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
import {
  scrapeURLWithXTwitter,
  xTwitterMaxReasonableTime,
  isXTwitterUrl,
} from "./x-twitter";
import { queryEngpickerVerdict, useIndex } from "../../../services";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import type { PdfMetadata } from "./pdf/types";
import { BrandingProfile } from "../../../types/branding";
import { BrandingNotSupportedError } from "../error";
import { isUrlBlocked } from "../../WebScraper/utils/blocklist";
import {
  canUseExchangeForRequest,
  type ExchangeScrapeMetadata,
} from "../../../lib/exchange";

export type Engine =
  | "exchange"
  | "fire-engine;chrome-cdp"
  | "fire-engine(retry);chrome-cdp"
  | "fire-engine;chrome-cdp;stealth"
  | "fire-engine(retry);chrome-cdp;stealth"
  | "fire-engine;tlsclient"
  | "fire-engine;tlsclient;stealth"
  | "playwright"
  | "fetch"
  | "pdf"
  | "document"
  | "index"
  | "index;documents"
  | "wikipedia"
  | "x-twitter";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;
const usePlaywright =
  config.PLAYWRIGHT_MICROSERVICE_URL !== "" &&
  config.PLAYWRIGHT_MICROSERVICE_URL !== undefined;
const useWikipedia =
  config.WIKIPEDIA_ENTERPRISE_USERNAME !== undefined &&
  config.WIKIPEDIA_ENTERPRISE_USERNAME !== "" &&
  config.WIKIPEDIA_ENTERPRISE_PASSWORD !== undefined &&
  config.WIKIPEDIA_ENTERPRISE_PASSWORD !== "";
const useXTwitter =
  (config.XAI_API_KEY !== undefined && config.XAI_API_KEY !== "") ||
  config.USE_DB_AUTHENTICATION === true;

const engines: Engine[] = [
  ...(useXTwitter ? ["x-twitter" as const] : []),
  ...(useWikipedia ? ["wikipedia" as const] : []),
  ...(useIndex ? ["index" as const, "index;documents" as const] : []),
  ...(useFireEngine
    ? [
        "fire-engine;chrome-cdp" as const,
        "fire-engine;chrome-cdp;stealth" as const,
        "fire-engine(retry);chrome-cdp" as const,
        "fire-engine(retry);chrome-cdp;stealth" as const,
        "fire-engine;tlsclient" as const,
        "fire-engine;tlsclient;stealth" as const,
      ]
    : []),
  ...(usePlaywright ? ["playwright" as const] : []),
  "fetch",
  "pdf",
  "document",
];

const featureFlags = [
  "actions",
  "waitFor",
  "screenshot",
  "screenshot@fullScreen",
  "pdf",
  "document",
  "audio",
  "video",
  "atsv",
  "location",
  "mobile",
  "skipTlsVerification",
  "useFastMode",
  "stealthProxy",
  "branding",
  "disableAdblock",
] as const;

export type FeatureFlag = (typeof featureFlags)[number];

const featureFlagOptions: {
  [F in FeatureFlag]: {
    priority: number;
  };
} = {
  actions: { priority: 20 },
  waitFor: { priority: 1 },
  screenshot: { priority: 10 },
  "screenshot@fullScreen": { priority: 10 },
  pdf: { priority: 100 },
  document: { priority: 100 },
  audio: { priority: 100 },
  video: { priority: 100 },
  atsv: { priority: 90 }, // NOTE: should atsv force to tlsclient? adjust priority if not
  useFastMode: { priority: 90 },
  location: { priority: 10 },
  mobile: { priority: 10 },
  skipTlsVerification: { priority: 10 },
  stealthProxy: { priority: 20 },
  branding: { priority: 20 }, // Requires CDP executeJavascript
  disableAdblock: { priority: 10 },
} as const;

export type EngineScrapeResult = {
  url: string;

  html: string;
  markdown?: string;
  json?: unknown;
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

  pdfMetadata?: PdfMetadata;

  cacheInfo?: {
    created_at: Date;
  };

  contentType?: string;

  youtubeTranscriptContent?: any;
  postprocessorsUsed?: string[];
  audioCookies?: BrowserCookie[];

  proxyUsed: "basic" | "stealth";
  timezone?: string;
  exchange?: ExchangeScrapeMetadata;
};

const engineHandlers: {
  [E in Engine]: (meta: Meta) => Promise<EngineScrapeResult>;
} = {
  "exchange": scrapeURLWithExchange,
  index: scrapeURLWithIndex,
  "index;documents": scrapeURLWithIndex,
  "fire-engine;chrome-cdp": scrapeURLWithFireEngineChromeCDP,
  "fire-engine(retry);chrome-cdp": scrapeURLWithFireEngineChromeCDP,
  "fire-engine;chrome-cdp;stealth": scrapeURLWithFireEngineChromeCDP,
  "fire-engine(retry);chrome-cdp;stealth": scrapeURLWithFireEngineChromeCDP,
  "fire-engine;tlsclient": scrapeURLWithFireEngineTLSClient,
  "fire-engine;tlsclient;stealth": scrapeURLWithFireEngineTLSClient,
  playwright: scrapeURLWithPlaywright,
  fetch: scrapeURLWithFetch,
  pdf: scrapePDF,
  document: scrapeDocument,
  wikipedia: scrapeURLWithWikipedia,
  "x-twitter": scrapeURLWithXTwitter,
};

const engineMRTs: {
  [E in Engine]: (meta: Meta) => number;
} = {
  "exchange": exchangeMaxReasonableTime,
  index: indexMaxReasonableTime,
  "index;documents": indexMaxReasonableTime,
  "fire-engine;chrome-cdp": meta =>
    fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  "fire-engine(retry);chrome-cdp": meta =>
    fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  "fire-engine;chrome-cdp;stealth": meta =>
    fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  "fire-engine(retry);chrome-cdp;stealth": meta =>
    fireEngineMaxReasonableTime(meta, "chrome-cdp"),
  "fire-engine;tlsclient": meta =>
    fireEngineMaxReasonableTime(meta, "tlsclient"),
  "fire-engine;tlsclient;stealth": meta =>
    fireEngineMaxReasonableTime(meta, "tlsclient"),
  playwright: playwrightMaxReasonableTime,
  fetch: fetchMaxReasonableTime,
  pdf: pdfMaxReasonableTime,
  document: documentMaxReasonableTime,
  wikipedia: wikipediaMaxReasonableTime,
  "x-twitter": xTwitterMaxReasonableTime,
};

const engineOptions: {
  [E in Engine]: {
    // A list of feature flags the engine supports.
    features: { [F in FeatureFlag]: boolean };

    // This defines the order of engines in general. The engine with the highest quality will be used the most.
    // Negative quality numbers are reserved for specialty engines, e.g. PDF, DOCX, stealth proxies
    quality: number;
  };
} = {
  "exchange": {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: 2000,
  },
  index: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      mobile: true,
      location: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
      branding: false,
      disableAdblock: true,
    },
    quality: 1000, // index should always be tried first
  },
  "fire-engine;chrome-cdp": {
    features: {
      actions: true,
      waitFor: true, // through actions transform
      screenshot: true, // through actions transform
      "screenshot@fullScreen": true, // through actions transform
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: false,
      branding: true,
      disableAdblock: false,
    },
    quality: 50,
  },
  "fire-engine(retry);chrome-cdp": {
    features: {
      actions: true,
      waitFor: true, // through actions transform
      screenshot: true, // through actions transform
      "screenshot@fullScreen": true, // through actions transform
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: false,
      branding: true,
      disableAdblock: false,
    },
    quality: 45,
  },
  "index;documents": {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: true,
      document: true,
      audio: false,
      video: false,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
      branding: false,
      disableAdblock: false,
    },
    quality: -1,
  },
  "fire-engine;chrome-cdp;stealth": {
    features: {
      actions: true,
      waitFor: true, // through actions transform
      screenshot: true, // through actions transform
      "screenshot@fullScreen": true, // through actions transform
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: true,
      branding: true,
      disableAdblock: false,
    },
    quality: -2,
  },
  "fire-engine(retry);chrome-cdp;stealth": {
    features: {
      actions: true,
      waitFor: true, // through actions transform
      screenshot: true, // through actions transform
      "screenshot@fullScreen": true, // through actions transform
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: true,
      branding: true,
      disableAdblock: false,
    },
    quality: -5,
  },
  playwright: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: 20,
  },
  "fire-engine;tlsclient": {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: true,
      location: true,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: 10,
  },
  "fire-engine;tlsclient;stealth": {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: true,
      video: true,
      atsv: true,
      location: true,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
      branding: false,
      disableAdblock: false,
    },
    quality: -15,
  },
  fetch: {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: 5,
  },
  pdf: {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: true,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: false,
      useFastMode: true,
      stealthProxy: true, // kinda...
      branding: false,
      disableAdblock: true,
    },
    quality: -20,
  },
  document: {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: true,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: false,
      useFastMode: true,
      stealthProxy: true, // kinda...
      branding: false,
      disableAdblock: true,
    },
    quality: -20,
  },
  wikipedia: {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: true,
    },
    quality: 500, // below index (1000) so cache is tried first, above fire-engine (50)
  },
  "x-twitter": {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      video: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: true,
    },
    quality: 1500,
  },
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
    // Skip index if a non-default PDF maxPages is specified
    getPDFMaxPages(meta.options.parsers) === undefined &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.profile === undefined
  );
}

export async function buildFallbackList(meta: Meta): Promise<
  {
    engine: Engine;
    unsupportedFeatures: Set<FeatureFlag>;
  }[]
> {
  if (
    !meta.internalOptions.agentIndexOnly &&
    meta.internalOptions.forceEngine === undefined
  ) {
    if (
      await canUseExchangeForRequest({
        url: meta.rewrittenUrl ?? meta.url,
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
        flags: meta.internalOptions.teamFlags ?? null,
      })
    ) {
      return [
        {
          engine: "exchange",
          unsupportedFeatures: new Set(),
        },
      ];
    }

    // A blocked URL can only have been admitted by the Exchange bypass in
    // blocklistMiddleware, which only applies to flagged orgs; if the
    // Exchange is no longer usable by execution time (catalog changed,
    // service down), fail closed rather than letting normal engines scrape
    // a blocklisted site. An error here also fails closed: this branch only
    // runs for flagged orgs, and a retryable scrape failure is preferable
    // to scraping a potentially blocklisted site with normal engines.
    if (
      meta.internalOptions.teamFlags?.professionalProfileCompanyDataBeta ===
      true
    ) {
      try {
        if (
          isUrlBlocked(
            meta.rewrittenUrl ?? meta.url,
            meta.internalOptions.teamFlags ?? null,
            {
              team_id: meta.internalOptions.teamId ?? null,
              origin: null,
            },
          )
        ) {
          return [];
        }
      } catch (error) {
        meta.logger.warn(
          "Exchange blocklist re-check failed; failing closed",
          { error },
        );
        return [];
      }
    }
  }

  const shouldPrioritizeTlsClient = meta.options.__experimental_engpicker
    ? (await queryEngpickerVerdict(
        meta.options.__experimental_omceDomain ?? new URL(meta.url).hostname,
      )) === "TlsClientOk"
    : false;

  const _engines: Engine[] = [
    ...engines,

    // enable fire-engine in self-hosted testing environment when mocks are supplied
    ...(!useFireEngine && meta.mock !== null
      ? ([
          "fire-engine;chrome-cdp",
          "fire-engine(retry);chrome-cdp",
          "fire-engine;chrome-cdp;stealth",
          "fire-engine(retry);chrome-cdp;stealth",
          // "fire-engine;tlsclient",
          // "fire-engine;tlsclient;stealth",
        ] as Engine[])
      : []),
  ];

  if (meta.options.lockdown) {
    const indexEngines: Engine[] = useIndex ? ["index", "index;documents"] : [];
    _engines.length = 0;
    _engines.push(...indexEngines);
    meta.internalOptions.forceEngine = indexEngines;
  } else if (meta.internalOptions.agentIndexOnly) {
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

  if (!isWikimediaUrl(meta.url) || Math.random() >= 0.5) {
    const wikiIndex = _engines.indexOf("wikipedia");
    if (wikiIndex !== -1) {
      _engines.splice(wikiIndex, 1);
    }
  }

  if (isXTwitterUrl(meta.url) && _engines.includes("x-twitter")) {
    _engines.length = 0;
    _engines.push("x-twitter");
  } else if (!isXTwitterUrl(meta.url)) {
    const xTwitterIndex = _engines.indexOf("x-twitter");
    if (xTwitterIndex !== -1) {
      _engines.splice(xTwitterIndex, 1);
    }
  }

  const prioritySum = [...meta.featureFlags].reduce(
    (a, x) => a + featureFlagOptions[x].priority,
    0,
  );
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
    const supportedFlags = new Set([
      ...Object.entries(engineOptions[engine].features)
        .filter(
          ([k, v]) => meta.featureFlags.has(k as FeatureFlag) && v === true,
        )
        .map(([k, _]) => k),
    ]);
    const supportScore = [...supportedFlags].reduce(
      (a, x) => a + featureFlagOptions[x].priority,
      0,
    );

    const unsupportedFeatures = new Set([...meta.featureFlags]);
    for (const flag of meta.featureFlags) {
      if (supportedFlags.has(flag)) {
        unsupportedFeatures.delete(flag);
      }
    }

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
  if (meta.featureFlags.has("stealthProxy")) {
    const stealthCapable = selectedEngines.filter(
      x => !x.unsupportedFeatures.has("stealthProxy"),
    );
    if (stealthCapable.length > 0) {
      selectedEngines = stealthCapable;
    }
  }

  if (
    selectedEngines.some(
      x => engineOptions[x.engine].quality > 0 && !x.engine.startsWith("index"),
    )
  ) {
    selectedEngines = selectedEngines.filter(
      x => engineOptions[x.engine].quality > 0,
    );
  }

  if (meta.internalOptions.forceEngine === undefined) {
    // retain force engine order
    // THIS SUCKS BUT IT WORKS
    const getEffectiveQuality = (engine: Engine) => {
      let quality = engineOptions[engine].quality;
      // When engpicker says TlsClientOk, prioritize tlsclient over CDP/CDPRetry
      if (shouldPrioritizeTlsClient) {
        if (engine === "fire-engine;tlsclient") {
          quality += 50; // Boost to 60, above CDP (50) but below index (1000)
        } else if (engine === "fire-engine;tlsclient;stealth") {
          quality += 14; // Boost to -1, stays negative but above chrome-cdp;stealth (-2)
        }
      }
      return quality;
    };

    selectedEngines.sort(
      (a, b) =>
        b.supportScore - a.supportScore ||
        getEffectiveQuality(b.engine) - getEffectiveQuality(a.engine),
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
  const fn = engineHandlers[engine];
  const logger = meta.logger.child({
    method: fn.name ?? "scrapeURLWithEngine",
    engine,
  });

  const featureFlags = new Set(meta.featureFlags);
  if (
    engineOptions[engine].features.stealthProxy &&
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
  const mrt = engineMRTs[engine];
  // shan't happen - mogery
  if (mrt === undefined) {
    meta.logger.warn("No MRT for engine", { engine });
    return 30000;
  }
  return mrt(meta);
}
