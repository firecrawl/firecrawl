import { ScrapeActionContent } from "../../../lib/entities";
import { BrandingProfile } from "../../../types/branding";
import { FeatureFlag } from "../lib/feature-flags";
import { Meta } from "../lib/meta";
import { PdfMetadata } from "../parsers/pdf/types";

export type BrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: unknown;
};

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
  audioCookies?: BrowserCookie[];

  proxyUsed: "basic" | "stealth";
  timezone?: string;
};

export type EngineName =
  | "index"
  | "fire-engine;chrome-cdp"
  | "playwright"
  | "fetch"
  | "wikipedia"
  | "x-twitter";

export type Engine = {
  name: EngineName;
  features: { [F in FeatureFlag]: boolean };
  scrape(meta: Meta): Promise<EngineScrapeResult>;
};

export type SpecialEngine = Engine & {
  special: {
    matches(url: string): boolean;
  };
};
