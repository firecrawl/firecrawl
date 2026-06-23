import type { EngineScrapeResult, Fetched } from "../types";

const DOCUMENT_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

export function isDocument(f: Fetched): boolean {
  const ct = f.contentType?.toLowerCase();
  if (!ct) return false;
  return DOCUMENT_CONTENT_TYPES.some(t => ct.includes(t));
}

export function htmlNeedsJs(f: Fetched): boolean {
  const ct = f.contentType;
  if (!ct || !ct.toLowerCase().includes("text/html")) return false;
  const sniff = f.buffer.subarray(0, Math.min(f.buffer.length, 64 * 1024));
  return /<script\b/i.test(sniff.toString("utf8"));
}

function decodeHtml(buf: Buffer): string {
  const html = buf.toString("utf8");
  const charset = (html.match(
    /<meta\b[^>]*charset\s*=\s*["']?([^"'\s\/>]+)/i,
  ) ?? [])[1];
  if (!charset || charset.trim().toLowerCase() === "utf-8") return html;
  try {
    return new TextDecoder(charset.trim()).decode(buf);
  } catch {
    return html;
  }
}

export function toHtmlResult(f: Fetched): EngineScrapeResult {
  return {
    url: f.url,
    html: decodeHtml(f.buffer),
    statusCode: f.status,
    contentType: f.contentType,
    proxyUsed: f.proxyUsed,
    error: f.pageError,
    screenshot: f.screenshots?.[0],
    actions: f.actions,
    youtubeTranscriptContent: f.youtubeTranscriptContent,
    timezone: f.timezone,
  };
}
