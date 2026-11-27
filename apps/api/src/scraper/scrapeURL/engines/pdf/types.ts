export type PDFProcessorResult = {
  html: string;
  markdown?: string;
  /**
   * Pages the underlying engine actually processed for this request.
   * Optional because not every local extractor reports it.
   */
  pagesProcessed?: number;
  /**
   * Total pages in the document as reported by the underlying engine.
   * Used when native page detection fails so truncated results still
   * surface a total page count.
   */
  pageCount?: number;
};

export type PdfMetadata = {
  /** Pages actually parsed for this request (capped by maxPages). */
  numPages: number;
  /**
   * True page count of the document, before any maxPages capping. Omitted when
   * the underlying engine couldn't determine it.
   */
  totalPages?: number;
  title?: string;
};

/** Raw (non-parsed) PDF fetches return the file base64-encoded inline. */
export const PDF_DOWNLOAD_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MILLISECONDS_PER_PAGE = 150;
