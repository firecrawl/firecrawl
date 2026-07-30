// Shared helpers for deciding whether a request/result is a document (PDF or
// office document) so that its credits can be metered against the dedicated
// DOCUMENT_CREDITS Autumn feature rather than the general CREDITS pool.
//
// Two detection surfaces exist and must agree on what "a document" means:
//   - request-side (pre-scrape, in checkCreditsMiddleware): only the URL(s) are
//     known, so we sniff by extension. This is best-effort — a document served
//     from an extension-less URL is only discovered after the scrape.
//   - result-side (post-scrape, in billScrapeJob): the resolved content type is
//     authoritative and covers extension-less URLs and uploads.

const DOCUMENT_URL_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".xlsx",
  ".xls",
];

// Content types produced by the pdf and document engines
// (scraper/scrapeURL/engines/{pdf,document}/index.ts). Matched as substrings
// since headers frequently carry a charset or other parameters.
const DOCUMENT_CONTENT_TYPE_MATCHERS = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

/**
 * True when the resolved content type belongs to a PDF or office document.
 * This is the authoritative, result-side signal used at billing time.
 */
export function isDocumentContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return DOCUMENT_CONTENT_TYPE_MATCHERS.some(type => ct.includes(type));
}

/**
 * Best-effort, extension-based check of whether a single URL points at a
 * document. Non-parsable strings are treated as non-documents.
 */
export function isDocumentUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return DOCUMENT_URL_EXTENSIONS.some(
    ext => pathname.endsWith(ext) || pathname.includes(ext + "/"),
  );
}

/**
 * Best-effort check of whether an incoming request body targets a document,
 * inspecting `url` (scrape/crawl/map) and `urls` (batch). Used by the pre-scrape
 * credit gate to check the DOCUMENT_CREDITS balance for likely-document
 * requests. Because DOCUMENT_CREDITS falls back to CREDITS in Autumn, a
 * false positive here is harmless for real documents; the extension list is
 * precise enough that HTML requests are not misclassified.
 */
export function requestLooksLikeDocument(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { url?: unknown; urls?: unknown };
  if (typeof b.url === "string" && isDocumentUrl(b.url)) return true;
  if (Array.isArray(b.urls)) {
    return b.urls.some(u => typeof u === "string" && isDocumentUrl(u));
  }
  return false;
}
