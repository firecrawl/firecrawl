export type PDFProcessorResult = {
  html: string;
  markdown?: string;
  /**
   * Pages the underlying engine actually processed for this request.
   * Currently populated only by fire-pdf (via OcrSuccessBody.pages_processed).
   * Optional because older fire-pdf builds and the runpodMU / pdf-parse
   * engines don't report it. Consumers must treat undefined as "no signal"
   * and fall back to whatever upstream metadata pass set.
   */
  pagesProcessed?: number;
};

export type PdfMetadata = { numPages: number; title?: string };

export const MAX_FILE_SIZE = 19 * 1024 * 1024; // 19MB
export const FIRE_PDF_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
export const MILLISECONDS_PER_PAGE = 150;
