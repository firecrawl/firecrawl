export type PdfPageMarkdown = {
  /** 1-based physical PDF page number returned by fire-pdf. */
  page: number;
  markdown: string;
};

/** Typed layout block as fire-pdf returns it (snake_case wire shape,
 * fire-pdf docs/blocks-schema.md). Cached artifacts store this shape. */
export type FirePdfBlock = {
  /** Stable within a response: p<page>.b<index in reading order>. */
  id: string;
  /** Public block taxonomy: title, section_header, text, table, formula,
   * figure, caption, page_number, ... New types may appear over time. */
  type: string;
  /** Raw layout-model label, passthrough for forward compatibility. */
  label: string | null;
  /** [x0,y0,x1,y1] normalized 0-1 to page dims; null when the page has no
   * known dims and the raw bbox isn't already normalized. */
  bbox: [number, number, number, number] | null;
  /** Markdown fragment this block contributed. */
  content: string;
  /** [start,end) char offsets into the document markdown; null when a
   * post-join transform rewrote the fragment. */
  markdown_span: [number, number] | null;
  reading_order: number;
  source: string | null;
  confidence: { layout: number | null; ocr: number | null };
};

export type FirePdfPageBlocks = {
  /** 1-based, matches `<!-- page N -->` markers in the document markdown. */
  page: number;
  /** Render dims in px — the bbox denormalization anchor. Null for pages
   * that never rendered (direct-extraction-only pages). */
  width: number | null;
  height: number | null;
  /** Page-level rollup: "ok" | "partial" | "failed" (open set). */
  status: string;
  items: FirePdfBlock[];
};

/** Public camelCase shape surfaced on `Document.blocks`. */
export type PdfBlockItem = {
  id: string;
  type: string;
  label: string | null;
  bbox: [number, number, number, number] | null;
  content: string;
  markdownSpan: [number, number] | null;
  readingOrder: number;
  source: string | null;
  confidence: { layout: number | null; ocr: number | null };
};

export type PdfPageBlocks = {
  pageNumber: number;
  width: number | null;
  height: number | null;
  status: string;
  items: PdfBlockItem[];
};

export type PDFProcessorResult = {
  html: string;
  markdown?: string;
  pageMarkdown?: PdfPageMarkdown[];
  /** Typed layout blocks (fire-pdf wire shape); present only when the
   * request set the `blocks` parser option. */
  blocks?: FirePdfPageBlocks[];
  /**
   * Pages the underlying engine actually processed for this request.
   * Currently populated only by fire-pdf (via OcrSuccessBody.pages_processed).
   * Optional because older fire-pdf builds and the runpodMU / pdf-parse
   * engines don't report it. Consumers must treat undefined as "no signal"
   * and fall back to whatever upstream metadata pass set.
   */
  pagesProcessed?: number;
};

export type PdfMetadata = {
  /** Pages actually parsed for this request (capped by maxPages). */
  numPages: number;
  /**
   * True page count of the document, before any maxPages capping. Omitted when
   * the underlying engine couldn't determine it (e.g. native detection failed),
   * so consumers must treat undefined as "no signal" rather than "not truncated".
   * When present, `totalPages > numPages` means the result was truncated.
   */
  totalPages?: number;
  title?: string;
};

export const MAX_FILE_SIZE = 19 * 1024 * 1024; // 19MB
export const FIRE_PDF_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
export const PDF_DOWNLOAD_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MILLISECONDS_PER_PAGE = 150;
