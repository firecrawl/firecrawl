export type PDFProcessorResult = { html: string; markdown?: string };

export type PdfMetadata = { numPages: number; title?: string };

export const MAX_FILE_SIZE = 19 * 1024 * 1024; // 19MB
export const MILLISECONDS_PER_PAGE = 150;
