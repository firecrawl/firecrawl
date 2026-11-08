export interface ScrapeResponseData {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Format {
  name: string;
  ext: string;
  apiFormats: string[];
  fromResponse(data: ScrapeResponseData): string | Buffer;
}
