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
  readonly cache?: boolean;
  readonly fileOnly?: boolean;
  readonly supportsProfile?: boolean;
  readonly prefetchesFiles?: boolean;
  readonly allowEmptyContent?: boolean;
}

export const coreEngineFeatures = {
  actions: { priority: 20 },
  waitFor: { priority: 1 },
  screenshot: { priority: 10 },
  "screenshot@fullScreen": { priority: 10 },
  pdf: { priority: 100 },
  document: { priority: 100 },
  image: { priority: 100 },
  atsv: { priority: 90 },
  useFastMode: { priority: 90 },
  location: { priority: 10 },
  mobile: { priority: 10 },
  skipTlsVerification: { priority: 10 },
  stealthProxy: { priority: 20 },
  disableAdblock: { priority: 10 },
} as const satisfies Record<EngineFeatureName, EngineFeature>;

// Registration order matches the waterfall tie-break order.
const coreEngineSpecsList = [
  {
    name: "wikipedia",
    quality: 500,
    features: {
      skipTlsVerification: true,
      useFastMode: true,
      disableAdblock: true,
    },
    method: "scrapeURLWithWikipedia",
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
  // The file engines (pdf, document) pass skipTlsVerification through to their
  // direct downloads, and a browser handoff already applied it upstream, so
  // they declare it supported: otherwise every file scrape that sets it
  // carries a misleading "may be partial" warning.
  {
    name: "pdf",
    quality: -20,
    fileOnly: true,
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
    fileOnly: true,
    features: {
      document: true,
      skipTlsVerification: true,
      useFastMode: true,
      stealthProxy: true, // kinda...
      disableAdblock: true,
    },
    method: "scrapeDocument",
  },
] as const satisfies ReadonlyArray<CoreEngineSpec>;

export type CoreEngineName = (typeof coreEngineSpecsList)[number]["name"];

export const coreEngineSpecs: ReadonlyArray<CoreEngineSpec<CoreEngineName>> =
  coreEngineSpecsList;
