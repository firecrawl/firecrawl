import { getIneligibleReason } from "../index";

type PdfResult = Parameters<typeof getIneligibleReason>[0];

const baseResult = (overrides: Partial<PdfResult> = {}): PdfResult =>
  ({
    pdfType: "TextBased",
    confidence: 0.99,
    isComplex: false,
    markdown: "# Title\n\nSome text",
    pageCount: 1,
    ...overrides,
  }) as PdfResult;

describe("getIneligibleReason", () => {
  it("serves a simple high-confidence TextBased PDF", () => {
    expect(getIneligibleReason(baseResult())).toBeNull();
  });

  it("rejects non-TextBased PDFs", () => {
    expect(getIneligibleReason(baseResult({ pdfType: "Scanned" }))).toBe(
      "pdfType=Scanned",
    );
  });

  it("rejects low-confidence PDFs", () => {
    expect(getIneligibleReason(baseResult({ confidence: 0.5 }))).toBe(
      "confidence=0.5",
    );
  });

  it("rejects complex TextBased PDFs by default (falls through to OCR)", () => {
    expect(getIneligibleReason(baseResult({ isComplex: true }))).toBe(
      "complex layout (tables/columns)",
    );
  });

  it("serves complex high-confidence TextBased PDFs when the flag is on", () => {
    expect(
      getIneligibleReason(baseResult({ isComplex: true }), true),
    ).toBeNull();
  });

  it("still rejects complex PDFs that are not TextBased even when the flag is on", () => {
    expect(
      getIneligibleReason(
        baseResult({ isComplex: true, pdfType: "Mixed" }),
        true,
      ),
    ).toBe("pdfType=Mixed");
  });

  it("still rejects complex low-confidence PDFs even when the flag is on", () => {
    expect(
      getIneligibleReason(
        baseResult({ isComplex: true, confidence: 0.8 }),
        true,
      ),
    ).toBe("confidence=0.8");
  });
});
