import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import { Meta } from "..";
import { documentMaxReasonableTime, scrapeDocument } from "./document";
import {
  fireEngineMaxReasonableTime,
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEnginePlaywright,
  scrapeURLWithFireEngineTLSClient,
} from "./fire-engine";
import { localFileMaxReasonableTime, scrapeLocalFile } from "./local-file";
import { pdfMaxReasonableTime, scrapePDF } from "./pdf";
import { fetchMaxReasonableTime, scrapeURLWithFetch } from "./fetch";
import {
  playwrightMaxReasonableTime,
  scrapeURLWithPlaywright,
} from "./playwright";
import { indexMaxReasonableTime, scrapeURLWithIndex } from "./index/index";
import { queryEngpickerVerdict, useIndex } from "../../../services";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import { PdfMetadata } from "@mendable/firecrawl-rs";
import { BrandingProfile } from "../../../types/branding";

export type Engine =
  | "fire-engine;chrome-cdp"
  | "fire-engine(retry);chrome-cdp"
  | "fire-engine;chrome-cdp;stealth"
  | "fire-engine(retry);chrome-cdp;stealth"
  | "fire-engine;playwright"
  | "fire-engine;playwright;stealth"
  | "fire-engine;tlsclient"
  | "fire-engine;tlsclient;stealth"
  | "playwright"
  | "fetch"
  | "pdf"
  | "document"
  | "local-file"
  | "index"
  | "index;documents";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;
const usePlaywright =
  config.PLAYWRIGHT_MICROSERVICE_URL !== "" &&
  config.PLAYWRIGHT_MICROSERVICE_URL !== undefined;

const engines: Engine[] = [
  ...(useIndex ? ["index" as const, "index;documents" as const] : []),
  ...(useFireEngine
    ? [
        "fire-engine;chrome-cdp" as const,
        "fire-engine;chrome-cdp;stealth" as const,
        "fire-engine(retry);chrome-cdp" as const,
        "fire-engine(retry);chrome-cdp;stealth" as const,
        "fire-engine;playwright" as const,
        "fire-engine;playwright;stealth" as const,
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

  proxyUsed: "basic" | "stealth";
  timezone?: string;
};

const engineHandlers: {
  [E in Engine]: (meta: Meta) => Promise<EngineScrapeResult>;
} = {
  index: scrapeURLWithIndex,
  "index;documents": scrapeURLWithIndex,
  "fire-engine;chrome-cdp": scrapeURLWithFireEngineChromeCDP,
  "fire-engine(retry);chrome-cdp": scrapeURLWithFireEngineChromeCDP,
  "fire-engine;chrome-cdp;stealth": scrapeURLWithFireEngineChromeCDP,
  "fire-engine(retry);chrome-cdp;stealth": scrapeURLWithFireEngineChromeCDP,
  "fire-engine;playwright": scrapeURLWithFireEnginePlaywright,
  "fire-engine;playwright;stealth": scrapeURLWithFireEnginePlaywright,
  "fire-engine;tlsclient": scrapeURLWithFireEngineTLSClient,
  "fire-engine;tlsclient;stealth": scrapeURLWithFireEngineTLSClient,
  playwright: scrapeURLWithPlaywright,
  fetch: scrapeURLWithFetch,
  pdf: scrapePDF,
  document: scrapeDocument,
  "local-file": scrapeLocalFile,
};

const engineMRTs: {
  [E in Engine]: (meta: Meta) => number;
} = {
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
  "fire-engine;playwright": meta =>
    fireEngineMaxReasonableTime(meta, "playwright"),
  "fire-engine;playwright;stealth": meta =>
    fireEngineMaxReasonableTime(meta, "playwright"),
  "fire-engine;tlsclient": meta =>
    fireEngineMaxReasonableTime(meta, "tlsclient"),
  "fire-engine;tlsclient;stealth": meta =>
    fireEngineMaxReasonableTime(meta, "tlsclient"),
  playwright: playwrightMaxReasonableTime,
  fetch: fetchMaxReasonableTime,
  pdf: pdfMaxReasonableTime,
  document: documentMaxReasonableTime,
  "local-file": localFileMaxReasonableTime,
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
  index: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: false,
      document: false,
      atsv: false,
      mobile: true,
      location: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
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
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
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
  "fire-engine;playwright": {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: false,
      document: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: false,
      useFastMode: false,
      stealthProxy: false,
      branding: false,
      disableAdblock: true,
    },
    quality: 40,
  },
  "fire-engine;playwright;stealth": {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: false,
      document: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: false,
      useFastMode: false,
      stealthProxy: true,
      branding: false,
      disableAdblock: true,
    },
    quality: -10,
  },
  playwright: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
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
  "local-file": {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      atsv: false,
      mobile: false,
      location: false,
      skipTlsVerification: false,
      useFastMode: false,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: -30,
  },
};

export function shouldUseIndex(meta: Meta) {
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
    meta.options.proxy !== "stealth"
  );
}

export async function buildFallbackList(meta: Meta): Promise<
  {
    engine: Engine;
    unsupportedFeatures: Set<FeatureFlag>;
  }[]
> {
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
          "fire-engine;playwright",
          // "fire-engine;tlsclient",
          // "fire-engine;playwright;stealth",
          // "fire-engine;tlsclient;stealth",
        ] as Engine[])
      : []),
  ];

  if (!shouldUseIndex(meta)) {
    const indexIndex = _engines.indexOf("index");
    if (indexIndex !== -1) {
      _engines.splice(indexIndex, 1);
    }
    const indexDocumentsIndex = _engines.indexOf("index;documents");
    if (indexDocumentsIndex !== -1) {
      _engines.splice(indexDocumentsIndex, 1);
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

  if (selectedEngines.some(x => engineOptions[x.engine].quality > 0)) {
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
      throw new Error(
        "Branding extraction requires Chrome CDP (fire-engine). ",
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
  if (engineOptions[engine].features.stealthProxy) {
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
