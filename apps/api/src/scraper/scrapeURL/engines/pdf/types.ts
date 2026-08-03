export type PdfPageMarkdown = {
  /** 1-based physical PDF page number returned by fire-pdf. */
  page: number;
  markdown: string;
};

export type PDFProcessorResult = {
  html: string;
  markdown?: string;
  pageMarkdown?: PdfPageMarkdown[];
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
