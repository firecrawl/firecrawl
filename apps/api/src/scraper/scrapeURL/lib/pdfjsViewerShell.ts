import { load } from "cheerio";

/**
 * Recognizes pages that are Mozilla's PDF.js viewer (or a build of it)
 * wrapped around a document, rather than a document themselves.
 *
 * Such a page renders as a 200 with a few kilobytes of toolbar and menu text
 * ("Thumbnails Document Outline Attachments Layers … Zoom In Automatic
 * Zoom …") while the PDF it displays never enters the DOM as text: pdf.js
 * paints pages onto canvases and, in a browser that blocks stylesheets (our
 * default chrome-cdp configuration), refuses to initialize at all. Archive
 * platforms serve documents this way behind tokenized links, so the viewer
 * chrome used to be billed and returned as the page content.
 *
 * Detection is deliberately conservative: two or more independent signals
 * are required, and a page whose own text (outside the viewer widgets) is
 * substantial is left alone, so an article that mentions pdf.js or embeds
 * a viewer among real content is never treated as a shell. Only shells the
 * resolver can open are classified: one that names its document, or one
 * built on the stock viewer (whose runtime exposes PDFViewerApplication). A
 * page driving pdfjs-dist directly keeps its HTML, as it always has.
 */

export type PdfJsViewerSignal =
  | "title"
  | "html-attributes"
  | "containers"
  | "scripts"
  | "runtime-api"
  | "pdfjs-lib"
  | "l10n"
  | "toolbar";

type PdfJsViewerDocumentSource = "query" | "script" | "embed";

export type PdfJsViewerDocument = {
  /** Absolute http(s) URL of the PDF the viewer displays. */
  url: string;
  source: PdfJsViewerDocumentSource;
};

export type PdfJsViewerShell = {
  kind: "pdfjs-viewer";
  /** Signals that matched, for logging. */
  signals: PdfJsViewerSignal[];
  /**
   * Where the page or its URL says the document lives, when it says so at
   * all. Null for viewers that load the document from a script the page
   * does not spell out (or from a default baked into the viewer build).
   */
  document: PdfJsViewerDocument | null;
};

/** Shells are small; a multi-megabyte page is content, whatever it embeds. */
const MAX_HTML_LENGTH = 4 * 1024 * 1024;
/** Independent signals a page must show before it is considered a shell. */
const MIN_SIGNALS = 2;
/**
 * Text (whitespace-collapsed characters) a page may carry outside the viewer
 * widgets and still be a shell. A stock viewer has none; custom builds add a
 * heading or a few controls. A page with a real article around an embedded
 * viewer is far above this and keeps its own content.
 */
export const MAX_HOST_TEXT_LENGTH = 1500;
/** `data-l10n-id="pdfjs-…"` occurrences before the l10n signal counts. */
const MIN_L10N_IDS = 3;
/** Distinct toolbar/menu terms before the vocabulary signal counts. */
const MIN_TOOLBAR_TERMS = 5;

/**
 * Cheap pre-filter so the regex pass only runs on pages that could possibly
 * be a viewer. Every signal except the toolbar vocabulary is built from
 * tokens listed here, and the toolbar signal alone never classifies a page
 * (two signals are required), so any page that could qualify contains at
 * least one of these.
 */
const QUICK_FILTER_RE =
  /pdfjs|pdf\.js|pdf\.mjs|pdf\.min\.m?js|pdf\.worker|pdf_viewer|\/build\/pdf|viewer\.m?js|viewer\.css|PDFViewerApplication|GlobalWorkerOptions|mozdisallowselectionprint|moznomarginboxes|outerContainer|viewerContainer|sidebarContainer|toolbarContainer|toolbarViewer|toolbarSidebar|secondaryToolbar|viewerAlert|pdfViewer|pdf(?:\.js)?\s*viewer/i;

const TITLE_RE = /<title\b[^>]*>[^<]*\bpdf(?:\.js)?\s*viewer\b[^<]*<\/title>/i;
const HTML_ATTRIBUTES_RE =
  /<html\b[^>]*\b(?:mozdisallowselectionprint|moznomarginboxes)\b/i;
const CONTAINERS_RE =
  /\bid=["']?(?:outerContainer|viewerContainer|sidebarContainer|toolbarContainer|toolbarViewer|toolbarSidebar|secondaryToolbar|viewerAlert)(?:["'\s>]|$)|\bclass=["'][^"']*\bpdfViewer\b/;
/**
 * The stock viewer's application object, which the resolver can drive. The
 * exact identifier only: configuring `PDFViewerApplicationOptions` says
 * nothing about the object itself being on the page.
 */
const RUNTIME_API_RE = /\bPDFViewerApplication\b/;
/** The library alone: a custom build the resolver cannot drive. */
const PDFJS_LIB_RE = /\bpdfjsLib\b|GlobalWorkerOptions\.workerSrc/;
const L10N_ID_RE = /data-l10n-id=["']pdfjs-/g;
// `src`/`href` must start after whitespace so a lazy-loading `data-src` or
// `data-href` hint is not counted as a loaded asset.
const SCRIPT_OR_LINK_SRC_RE =
  /<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
/** Paths pdf.js builds are served from, tested against each script/link URL. */
const SCRIPT_PATH_PATTERNS = [
  /pdfjs-dist/i,
  /pdf\.worker/i,
  /(?:^|\/)pdf(?:\.min)?\.m?js(?:$|[?#])/i,
  /\/build\/pdf\b/i,
  /(?:^|\/)viewer\.m?js(?:$|[?#])/i,
  /(?:^|\/)viewer\.css(?:$|[?#])/i,
  /pdf_viewer\.(?:m?js|css)/i,
  /(?:^|\/)pdfjs\//i,
];
/** Strings pdf.js's toolbar, sidebar and menus put on the page. */
const TOOLBAR_TERMS = [
  "Thumbnails",
  "Document Outline",
  "Attachments",
  "Layers",
  "Zoom In",
  "Zoom Out",
  "Automatic Zoom",
  "Actual Size",
  "Page Fit",
  "Page Width",
  "Presentation Mode",
  "Rotate Clockwise",
  "Rotate Counterclockwise",
  "Text Selection Tool",
  "Hand Tool",
  "Document Properties",
  "Find in Document",
  "Previous Page",
  "Next Page",
  "Current Page",
  "Go to First Page",
  "Go to Last Page",
  "Toggle Sidebar",
  "Vertical Scrolling",
  "Horizontal Scrolling",
  "Wrapped Scrolling",
  "Odd Spreads",
  "Even Spreads",
  "No Spreads",
  "Highlight All",
  "Match Case",
  "Match Diacritics",
  "Whole Words",
].map(term => new RegExp(`\\b${term.replace(/ /g, "\\s+")}\\b`, "i"));

/**
 * Everything that belongs to the viewer rather than to the page hosting it.
 * Removed before measuring how much text the page has of its own; the text
 * layer is the rendered PDF, not host content.
 */
const VIEWER_WIDGET_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "dialog",
  "[role='dialog']",
  "#outerContainer",
  "#viewerContainer",
  "#printContainer",
  "#sidebarContainer",
  "#toolbarContainer",
  "#secondaryToolbar",
  ".pdfViewer",
  ".textLayer",
  ".annotationLayer",
  ".canvasWrapper",
  "[data-l10n-id^='pdfjs-']",
].join(", ");

function collectSignals(html: string): PdfJsViewerSignal[] {
  const signals: PdfJsViewerSignal[] = [];
  if (TITLE_RE.test(html)) signals.push("title");
  if (HTML_ATTRIBUTES_RE.test(html)) signals.push("html-attributes");
  if (CONTAINERS_RE.test(html)) signals.push("containers");
  if (hasPdfJsScript(html)) signals.push("scripts");
  if (RUNTIME_API_RE.test(html)) signals.push("runtime-api");
  if (PDFJS_LIB_RE.test(html)) signals.push("pdfjs-lib");
  if (countMatches(html, L10N_ID_RE) >= MIN_L10N_IDS) signals.push("l10n");
  if (TOOLBAR_TERMS.filter(re => re.test(html)).length >= MIN_TOOLBAR_TERMS) {
    signals.push("toolbar");
  }
  return signals;
}

function hasPdfJsScript(html: string): boolean {
  for (const match of html.matchAll(SCRIPT_OR_LINK_SRC_RE)) {
    const src = match[1].trim();
    if (SCRIPT_PATH_PATTERNS.some(re => re.test(src))) return true;
  }
  return false;
}

function countMatches(html: string, re: RegExp): number {
  let count = 0;
  for (const _ of html.matchAll(re)) {
    count++;
    if (count >= MIN_L10N_IDS) break;
  }
  return count;
}

/**
 * Characters of text the page carries outside the viewer widgets. Returns
 * Infinity when the HTML cannot be parsed, so an unparseable page is never
 * classified as a shell.
 */
function hostTextLength(html: string): number {
  try {
    const $ = load(html);
    $(VIEWER_WIDGET_SELECTORS).remove();
    const body = $("body");
    const text = body.length > 0 ? body.text() : $.root().text();
    return text.replace(/\s+/g, " ").trim().length;
  } catch {
    return Infinity;
  }
}

/**
 * Classifies rendered (or raw) HTML as a PDF.js viewer shell. `pageUrl` is
 * the final URL of the page, used to read the standard viewer's `file=`
 * parameter and to resolve relative document locations.
 */
export function detectPdfJsViewerShell(
  html: string,
  pageUrl: string,
): PdfJsViewerShell | null {
  if (!html || html.length > MAX_HTML_LENGTH) return null;
  if (!QUICK_FILTER_RE.test(html)) return null;

  const signals = collectSignals(html);
  if (signals.length < MIN_SIGNALS) return null;
  if (hostTextLength(html) > MAX_HOST_TEXT_LENGTH) return null;

  // Classify only what the resolver can open: a document the page names, or
  // a viewer whose runtime exposes PDFViewerApplication. For an unnamed page
  // that means a reference to the application object itself, or the stock
  // viewer's own signature: Mozilla's `moz*` html attributes together with
  // its `pdfjs-` l10n ids, markup that only viewer.html ships and that always
  // comes with PDFViewerApplication on window. A title or toolbar strings a
  // custom build may have copied are not evidence. A page that drives
  // pdfjs-dist itself offers none of this and keeps its HTML, as before.
  const document = locatePdfJsViewerDocument(html, pageUrl);
  const resolvable =
    document !== null ||
    signals.includes("runtime-api") ||
    (signals.includes("html-attributes") && signals.includes("l10n"));
  if (!resolvable) return null;

  return { kind: "pdfjs-viewer", signals, document };
}

/**
 * Script patterns a page uses to point the viewer at a document. Only
 * literal URLs are useful here: a variable or template expression cannot be
 * resolved without running the page.
 */
const SCRIPT_DOCUMENT_PATTERNS = [
  /PDFViewerApplication\.open\(\s*["'`]([^"'`\s]+)["'`]/,
  /PDFViewerApplication\.open\(\s*\{[^}]*?\burl\s*:\s*["'`]([^"'`\s]+)["'`]/,
  /\bDEFAULT_URL\s*=\s*["'`]([^"'`\s]+)["'`]/,
  /\bdefaultUrl\b["']?\s*[:=,]\s*["'`]([^"'`\s]+)["'`]/i,
  /\bgetDocument\(\s*["'`]([^"'`\s]+)["'`]/,
  /\bgetDocument\(\s*\{[^}]*?\burl\s*:\s*["'`]([^"'`\s]+)["'`]/,
];

const EMBED_TAG_RE = /<(embed|object|iframe)\b([^>]*)>/gi;
// Anchored at an attribute boundary so `data-src` (a lazy-loading hint for a
// document the page is not displaying) is not read as `src`.
const ATTRIBUTE_RE =
  /(?:^|\s)(src|data|type)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

function decodeAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Resolves a candidate document location to an absolute http(s) URL, or
 * null when it is not one (blob:/data: URLs, template expressions, garbage).
 */
function resolveHttpUrl(raw: string, base: string): string | null {
  const candidate = decodeAttribute(raw).trim();
  if (candidate.length === 0 || candidate.includes("${")) return null;
  try {
    const url = new URL(candidate, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Whether a URL's path is where pdf.js viewers live (`…/web/viewer.html`,
 * a `pdfjs` directory, a `pdf_viewer` build). */
function isViewerLikeUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return (
      /(?:^|\/)viewer\.x?html?$/.test(pathname) ||
      /pdfjs|pdf\.js|pdf_viewer/.test(pathname)
    );
  } catch {
    return false;
  }
}

/** The standard viewer takes its document from `viewer.html?file=…`. */
function documentUrlFromViewerUrl(pageUrl: string): string | null {
  try {
    const file = new URL(pageUrl).searchParams.get("file");
    return file ? resolveHttpUrl(file, pageUrl) : null;
  } catch {
    return null;
  }
}

function documentUrlFromEmbeds(html: string, pageUrl: string): string | null {
  for (const tag of html.matchAll(EMBED_TAG_RE)) {
    const attributes: Record<string, string> = {};
    for (const attribute of tag[2].matchAll(ATTRIBUTE_RE)) {
      attributes[attribute[1].toLowerCase()] =
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    }
    const raw = attributes.src ?? attributes.data;
    if (!raw) continue;
    const url = resolveHttpUrl(raw, pageUrl);
    if (url === null) continue;

    const type = (attributes.type ?? "").toLowerCase();
    const pathname = new URL(url).pathname.toLowerCase();
    if (type.startsWith("application/pdf") || pathname.endsWith(".pdf")) {
      return url;
    }
    // A nested standard viewer (`<iframe src="…/viewer.html?file=…">`): the
    // document is the frame's `file=` parameter, relative to the frame. Only
    // frames that look like a viewer qualify; an unrelated frame that happens
    // to carry a `file=` parameter is not displaying a document.
    if (isViewerLikeUrl(url)) {
      const nested = documentUrlFromViewerUrl(url);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * Finds the document a viewer page displays, in order of reliability: the
 * standard viewer's `file=` query parameter, a literal URL handed to the
 * viewer or to pdf.js in a script, then an embed/object/iframe pointing at a
 * PDF (or at a nested viewer). Null when the page does not spell it out.
 */
export function locatePdfJsViewerDocument(
  html: string,
  pageUrl: string,
): PdfJsViewerDocument | null {
  const fromQuery = documentUrlFromViewerUrl(pageUrl);
  if (fromQuery !== null) return { url: fromQuery, source: "query" };

  for (const pattern of SCRIPT_DOCUMENT_PATTERNS) {
    const match = pattern.exec(html);
    if (match === null) continue;
    const url = resolveHttpUrl(match[1], pageUrl);
    if (url !== null) return { url, source: "script" };
  }

  const fromEmbed = documentUrlFromEmbeds(html, pageUrl);
  if (fromEmbed !== null) return { url: fromEmbed, source: "embed" };

  return null;
}
