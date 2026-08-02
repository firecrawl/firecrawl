import { getIneligibleReason } from "../eligibility";

const baseResult = {
  pdfType: "TextBased",
  confidence: 0.99,
  isComplex: false,
  markdown: "hello",
  pagesNeedingOcr: [],
};

describe("getIneligibleReason", () => {
  it("accepts clean text-based PDFs", () => {
    expect(getIneligibleReason(baseResult)).toBeNull();
  });

  it("rejects text-based PDFs with pages that need OCR", () => {
    expect(
      getIneligibleReason({
        ...baseResult,
        pagesNeedingOcr: [2, 5],
      }),
    ).toBe("pages_needing_ocr=2");
  });
});
