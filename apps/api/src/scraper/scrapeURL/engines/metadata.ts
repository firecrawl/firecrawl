/*
 * Static metadata for the built-in scrape engines and feature flag priorities.
 *
 * Kept free of runtime imports so `coreParts()` can register engine metadata
 * and `service.describe()` can report it without loading configuration,
 * databases, Redis, or engine implementations.
 */
import type {
  EngineFeature,
  EngineFeatureName,
  EngineName,
} from "../../../service/engines";

export interface CoreEngineSpec<N extends EngineName = EngineName> {
  readonly name: N;
  readonly quality: number;
  readonly features: { readonly [F in EngineFeatureName]?: boolean };
  /** Function name of the engine's scrape handler, preserved on child loggers. */
  readonly method: string;
  readonly explicitOnly?: boolean;
}

export const coreEngineFeatures = {
  actions: { priority: 20 },
  waitFor: { priority: 1 },
  screenshot: { priority: 10 },
  "screenshot@fullScreen": { priority: 10 },
  pdf: { priority: 100 },
  document: { priority: 100 },
  image: { priority: 100 },
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
} as const satisfies Record<EngineFeatureName, EngineFeature>;

const chromeCdpFeatures = {
  actions: true,
  waitFor: true, // through actions transform
  screenshot: true, // through actions transform
  "screenshot@fullScreen": true, // through actions transform
  audio: true,
  video: true,
  location: true,
  mobile: true,
  skipTlsVerification: true,
  branding: true,
} as const;

// Registration order matches the waterfall tie-break order.
const coreEngineSpecsList = [
  {
    name: "wikipedia",
    quality: 500, // below index (1000) so cache is tried first, above fire-engine (50)
    features: {
      skipTlsVerification: true,
      useFastMode: true,
      disableAdblock: true,
    },
    method: "scrapeURLWithWikipedia",
  },
  {
    name: "index",
    quality: 1000, // index should always be tried first
    features: {
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      mobile: true,
      location: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
      disableAdblock: true,
    },
    method: "scrapeURLWithIndex",
  },
  {
    name: "index;documents",
    quality: -1,
    features: {
      waitFor: true,
      screenshot: true,
      "screenshot@fullScreen": true,
      pdf: true,
      document: true,
      image: true,
      location: true,
      mobile: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
    },
    method: "scrapeURLWithIndex",
  },
  {
    name: "fire-engine;chrome-cdp",
    quality: 50,
    features: chromeCdpFeatures,
    method: "scrapeURLWithFireEngineChromeCDP",
  },
  {
    name: "fire-engine;chrome-cdp;stealth",
    quality: -2,
    features: { ...chromeCdpFeatures, stealthProxy: true },
    method: "scrapeURLWithFireEngineChromeCDP",
  },
  {
    name: "fire-engine(retry);chrome-cdp",
    quality: 45,
    features: chromeCdpFeatures,
    method: "scrapeURLWithFireEngineChromeCDP",
  },
  {
    name: "fire-engine(retry);chrome-cdp;stealth",
    quality: -5,
    features: { ...chromeCdpFeatures, stealthProxy: true },
    method: "scrapeURLWithFireEngineChromeCDP",
  },
  {
    name: "fire-engine;tlsclient",
    quality: 10,
    features: {
      audio: true,
      video: true,
      atsv: true,
      location: true,
      skipTlsVerification: true,
      useFastMode: true,
    },
    method: "scrapeURLWithFireEngineTLSClient",
  },
  {
    name: "fire-engine;tlsclient;stealth",
    quality: -15,
    features: {
      audio: true,
      video: true,
      atsv: true,
      location: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true,
    },
    method: "scrapeURLWithFireEngineTLSClient",
  },
  {
    name: "playwright",
    quality: 20,
    features: {
      waitFor: true,
      skipTlsVerification: true,
    },
    method: "scrapeURLWithPlaywright",
  },
  {
    name: "fetch",
    quality: 5,
    features: {
      skipTlsVerification: true,
      useFastMode: true,
    },
    method: "scrapeURLWithFetch",
  },
  // The file engines (pdf, document, image) pass skipTlsVerification through
  // to their direct downloads, and a browser handoff already applied it
  // upstream, so they declare it supported: otherwise every file scrape that
  // sets it carries a misleading "may be partial" warning.
  {
    name: "pdf",
    quality: -20,
    features: {
      pdf: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true, // kinda...
      disableAdblock: true,
    },
    method: "scrapePDF",
  },
  {
    name: "document",
    quality: -20,
    features: {
      document: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true, // kinda...
      disableAdblock: true,
    },
    method: "scrapeDocument",
  },
  {
    name: "image",
    quality: -20,
    features: {
      image: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true, // kinda...
      disableAdblock: true,
    },
    method: "scrapeImage",
  },
  {
    name: "exchange",
    quality: 2000,
    features: {
      skipTlsVerification: true,
      useFastMode: true,
    },
    method: "scrapeURLWithExchange",
    explicitOnly: true,
  },
] as const satisfies readonly CoreEngineSpec[];

export type CoreEngineName = (typeof coreEngineSpecsList)[number]["name"];

export const coreEngineSpecs: readonly CoreEngineSpec<CoreEngineName>[] =
  coreEngineSpecsList;
