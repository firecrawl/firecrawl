import type { FirePdfPageBlocks, PdfPageBlocks } from "./types";

/**
 * Project fire-pdf's snake_case block wire shape onto the camelCase shape
 * surfaced on `Document.blocks`. Pure adapter — keeps the provider contract
 * translation out of the engine orchestration and next to the wire schema
 * it mirrors (fire-pdf/schema.ts).
 */
export function toPublicBlocks(blocks: FirePdfPageBlocks[]): PdfPageBlocks[] {
  return blocks.map(page => ({
    pageNumber: page.page,
    width: page.width,
    height: page.height,
    status: page.status,
    items: page.items.map(item => ({
      id: item.id,
      type: item.type,
      label: item.label,
      bbox: item.bbox,
      content: item.content,
      markdownSpan: item.markdown_span,
      readingOrder: item.reading_order,
      source: item.source,
      confidence: item.confidence,
    })),
  }));
}
