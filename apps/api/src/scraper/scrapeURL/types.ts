import type { ScrapeActionContent } from "../../lib/entities";
import type { BrandingProfile } from "../../types/branding";
import type { BrowserCookie } from "./context";

export type Engine =
  | "gateway"
  | "cdp"
  | "playwright"
  | "wikipedia"
  | "index"
  | "pdf"
  | "document";

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

import type { PdfMetadata } from "./parse/pdf/types";

export type FetchedActions = {
  screenshots: string[];
  scrapes: ScrapeActionContent[];
  javascriptReturns: { type: string; value: unknown }[];
  pdfs: string[];
};

/**
 * Raw fetch output produced by every fetch path (gateway, cdp, wikipedia,
 * index). Downstream parsers sniff `buffer` to decide PDF/doc/html routing.
 */
export type Fetched = {
  via: Engine;
  url: string;
  status: number;
  headers: Array<{ name: string; value: string }>;
  contentType?: string;
  buffer: Buffer;
  proxyUsed: "basic" | "stealth";

  // CDP-only extras
  screenshots?: string[];
  actions?: FetchedActions;
  pageError?: string;
  youtubeTranscriptContent?: any;
  timezone?: string;

  // Index cache only
  cacheInfo?: { created_at: Date };
};

/**
 * Intermediate result produced by each path after content-specific parsing.
 * Flows into `buildDocument()` to populate fields on `Document`.
 */
export type EngineScrapeResult = {
  url: string;
  html: string;
  markdown?: string;
  statusCode: number;
  error?: string;

  screenshot?: string;
  actions?: FetchedActions;
  branding?: BrandingProfile;
  pdfMetadata?: PdfMetadata;
  cacheInfo?: { created_at: Date };
  contentType?: string;
  youtubeTranscriptContent?: any;
  postprocessorsUsed?: string[];
  audioCookies?: BrowserCookie[];
  proxyUsed: "basic" | "stealth";
  timezone?: string;
};
