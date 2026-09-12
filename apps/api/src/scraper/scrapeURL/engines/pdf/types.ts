import type { z } from "zod";
import type { firePdfBlockPagesSchema } from "./fire-pdf/schema";

export type PdfPageMarkdown = {
  /** 1-based physical PDF page number returned by fire-pdf. */
  page: number;
  markdown: string;
};

/** Typed layout blocks as fire-pdf returns them (snake_case wire shape,
 * fire-pdf docs/blocks-schema.md). Inferred from the zod wire schema so the
 * contract lives in exactly one place. Cached artifacts store this shape. */
export type FirePdfPageBlocks = z.infer<typeof firePdfBlockPagesSchema>[number];

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
/** Above this, FirePDF submits go by GCS reference (async /jobs with
 * `input_gcs_uri`) instead of inline base64 — inline bodies are capped by
 * fire-pdf's JSON body limit and V8 string ceilings. */
export const FIRE_PDF_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
/** Absolute ceiling for inline (base64 JSON) FirePDF submits, forced or
 * not: fire-pdf's 100MB body limit divided by base64 inflation is ~74MB
 * raw; 70MB leaves margin for the JSON envelope. Beyond this the inline
 * path is a guaranteed 413, so callers shouldn't even build the string. */
export const FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE = 70 * 1024 * 1024; // 70MB
/** Ceiling for by-reference FirePDF submits, and therefore for parse-path
 * downloads (which stream to disk and hand large files to FirePDF by GCS
 * reference). Mirrors fire-pdf's FIRE_PDF_GCS_INPUT_MAX_BYTES default —
 * raise the two together. */
export const FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE = 256 * 1024 * 1024; // 256MB
/** Raw (non-parsed) PDF fetches return the file base64'd inline in the
 * response, so they keep a tighter cap than the parse path. */
export const PDF_DOWNLOAD_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MILLISECONDS_PER_PAGE = 150;
