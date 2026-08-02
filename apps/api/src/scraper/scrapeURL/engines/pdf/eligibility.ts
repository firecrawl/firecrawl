type PdfExtractionEligibilityInput = {
  pdfType: string;
  confidence: number;
  isComplex: boolean;
  markdown?: string | null;
  pagesNeedingOcr?: readonly number[] | null;
};

/** Check if the PDF is eligible for Rust extraction, returning a rejection reason or null. */
export function getIneligibleReason(
  result: PdfExtractionEligibilityInput,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  if (result.pagesNeedingOcr && result.pagesNeedingOcr.length > 0) {
    return `pages_needing_ocr=${result.pagesNeedingOcr.length}`;
  }
  if (!result.markdown?.length)
    return "empty markdown (unexpected for TextBased)";
  return null;
}
