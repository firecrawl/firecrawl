import { ScrapeActionContent } from "../../../lib/entities";
import { Meta } from "..";
import { documentMaxReasonableTime, scrapeDocument } from "./document";
import {
  fireEngineMaxReasonableTime,
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEnginePlaywright,
  scrapeURLWithFireEngineTLSClient,
} from "./fire-engine";
import { pdfMaxReasonableTime, scrapePDF } from "./pdf";
import { fetchMaxReasonableTime, scrapeURLWithFetch } from "./fetch";
import {
  playwrightMaxReasonableTime,
  scrapeURLWithPlaywright,
} from "./playwright";
import { indexMaxReasonableTime, scrapeURLWithIndex } from "./index/index";
import { useIndex } from "../../../services";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import { PdfMetadata } from "@mendable/firecrawl-rs";

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
  | "index"
  | "index;documents";

const useFireEngine =
  process.env.FIRE_ENGINE_BETA_URL !== "" &&
  process.env.FIRE_ENGINE_BETA_URL !== undefined;
const usePlaywright =
  process.env.PLAYWRIGHT_MICROSERVICE_URL !== "" &&
  process.env.PLAYWRIGHT_MICROSERVICE_URL !== undefined;

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

  pdfMetadata?: PdfMetadata;

  cacheInfo?: {
    created_at: Date;
  };

  contentType?: string;

  youtubeTranscriptContent?: any;
  postprocessorsUsed?: string[];

  proxyUsed: "basic" | "stealth";
  json?: any;
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
      disableAdblock: true,
    },
    quality: -20,
  },
};

export function shouldUseIndex(meta: Meta) {
  return (
    useIndex &&
    process.env.FIRECRAWL_INDEX_WRITE_ONLY !== "true" &&
    meta.options.waitFor === 0 &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    // Skip index if a non-default PDF maxPages is specified
    getPDFMaxPages(meta.options.parsers) === undefined &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.proxy !== "stealth"
  );
}

export function buildFallbackList(meta: Meta): {
  engine: Engine;
  unsupportedFeatures: Set<FeatureFlag>;
}[] {
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
    selectedEngines.sort(
      (a, b) =>
        b.supportScore - a.supportScore ||
        engineOptions[b.engine].quality - engineOptions[a.engine].quality,
    );
  }

  meta.logger.info("Selected engines", {
    selectedEngines,
  });

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
  const _meta = {
    ...meta,
    logger,
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
