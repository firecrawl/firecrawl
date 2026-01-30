import { ScrapeActionContent } from "../../../lib/entities";
import { config } from "../../../config";
import { Meta } from "..";
import { scrapeURLWithFireEngineChromeCDP } from "./fire-engine";
import { scrapeURLWithFetch } from "./fetch";
import { scrapeURLWithPlaywright } from "./playwright";
import { scrapeURLWithIndex } from "./index/index";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import { PdfMetadata } from "@mendable/firecrawl-rs";
import { BrandingProfile } from "../../../types/branding";
import { useIndex } from "../../../services";
import { EngineError } from "../error";

export type Engine =
  | "fire-engine;chrome-cdp"
  | "playwright"
  | "fetch"
  | "index";

const featureFlags = [
  "actions",
  "waitFor",
  "screenshot",
  "screenshot@fullScreen",
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

  // Internal-only: used for PDF/document detection after engine response.
  binaryFile?: {
    name?: string;
    content: string;
  };
};

const engineHandlers: {
  [E in Engine]: (meta: Meta) => Promise<EngineScrapeResult>;
} = {
  index: scrapeURLWithIndex,
  "fire-engine;chrome-cdp": scrapeURLWithFireEngineChromeCDP,
  playwright: scrapeURLWithPlaywright,
  fetch: scrapeURLWithFetch,
};

const engineOptions: {
  [E in Engine]: {
    features: { [F in FeatureFlag]: boolean };
  };
} = {
  index: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: true,
    },
  },
  "fire-engine;chrome-cdp": {
    features: {
      actions: true,
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      atsv: false,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: true,
      branding: true,
      disableAdblock: false,
    },
  },
  playwright: {
    features: {
      actions: false,
      waitFor: true,
      screenshot: false,
      "screenshot@fullScreen": false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
  },
  fetch: {
    features: {
      actions: false,
      waitFor: false,
      screenshot: false,
      "screenshot@fullScreen": false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
  },
};

export function selectLiveEngine(meta: Meta): Engine {
  if (config.FIRE_ENGINE_BETA_URL) {
    return "fire-engine;chrome-cdp";
  }

  if (config.PLAYWRIGHT_MICROSERVICE_URL) {
    return "playwright";
  }

  meta.logger.info("No live engine configured; defaulting to fetch");
  return "fetch";
}

export function getUnsupportedFeatures(
  meta: Meta,
  engine: Engine,
): Set<FeatureFlag> {
  const supportedFlags = new Set(
    Object.entries(engineOptions[engine].features)
      .filter(
        ([flag, isSupported]) =>
          isSupported && meta.featureFlags.has(flag as FeatureFlag),
      )
      .map(([flag]) => flag),
  );

  const unsupportedFeatures = new Set([...meta.featureFlags]);
  for (const flag of meta.featureFlags) {
    if (supportedFlags.has(flag)) {
      unsupportedFeatures.delete(flag);
    }
  }

  return unsupportedFeatures;
}

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

export async function scrapeURLWithEngine(
  meta: Meta,
  engine: Engine,
): Promise<EngineScrapeResult> {
  const fn = engineHandlers[engine];
  if (!fn) {
    throw new EngineError(`Unsupported engine: ${engine}`);
  }

  const logger = meta.logger.child({
    method: fn.name ?? "scrapeURLWithEngine",
    engine,
  });

  const _meta = {
    ...meta,
    logger,
    featureFlags: new Set(meta.featureFlags),
  };

  return await fn(_meta);
}
