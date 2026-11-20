import {
  PDF_MIN_DENSITY_CHARS_PER_PAGE,
  PDF_MIN_PAGES_FOR_DENSITY_CHECK,
  assessPdfExtractionQuality,
  effectiveProcessedPages,
  getRustPdfIneligibleReason,
  pickRicherPdfResult,
} from "./pdfQuality";
import type { PDFProcessorResult } from "./types";

/**
 * Completeness guard for PDF stage results (firecrawl/firecrawl #5759).
 *
 * A 46-page gazette PDF returns only its repeated page header from the Rust
 * extractor (~3,096 chars) while pdf-parse extracts the full body (86,666
 * chars). A stage result that is suspiciously sparse must fall through to
 * the next engine instead of shipping as a successful partial result.
 * Low density only ever triggers *verification* against another extractor —
 * it never proves the document itself is sparse, so nothing here rejects a
 * result outright.
 */

function repeatText(charsPerPage: number, pages: number): string {
  return "x".repeat(charsPerPage * pages);
}

function rustResult(overrides: {
  pdfType?: string;
  confidence?: number;
  isComplex?: boolean;
  markdown?: string | null;
  pageCount?: number;
}) {
  return {
    pdfType: overrides.pdfType ?? "TextBased",
    confidence: overrides.confidence ?? 1,
    isComplex: overrides.isComplex ?? false,
    markdown: overrides.markdown ?? "x".repeat(10_000),
    pageCount: overrides.pageCount ?? 10,
  };
}

function processorResult(markdown: string): PDFProcessorResult {
  return { html: markdown, markdown };
}

describe("assessPdfExtractionQuality", () => {
  it("does not flag a normal dense document", () => {
    const quality = assessPdfExtractionQuality(repeatText(500, 10), 10);
    expect(quality.suspicious).toBe(false);
    expect(quality.densityCharsPerPage).toBeCloseTo(500);
  });

  it("flags the reported Rust failure (3,096 chars / 46 pages)", () => {
    const quality = assessPdfExtractionQuality(repeatText(67, 46), 46);
    expect(quality.suspicious).toBe(true);
    expect(quality.reason).toMatch(/67/);
    expect(quality.reason).toMatch(/46 pages/);
  });

  it("flags the reported OCR-mode failure (2,677 chars / 46 pages)", () => {
    const quality = assessPdfExtractionQuality(repeatText(58, 46), 46);
    expect(quality.suspicious).toBe(true);
  });

  it("does not flag empty markdown (emptiness has its own handling)", () => {
    // No text at all is a different signal from suspiciously little text,
    // and it already has owners: the Rust stage rejects an empty TextBased
    // result, and the FirePDF cache deliberately serves cached empty PDF
    // results as valid answers. The density signal is only for non-empty
    // degenerate output — the reported #5759 failure has 3,096 chars.
    expect(assessPdfExtractionQuality("", 46).suspicious).toBe(false);
    expect(assessPdfExtractionQuality("   \n\t  ", 46).suspicious).toBe(false);
    expect(assessPdfExtractionQuality(undefined, 46).suspicious).toBe(false);
  });

  it("flags a sparse one-line-per-page form as suspicious (verification, not rejection)", () => {
    // 40 chars/page is below the bar — the router must verify it against
    // another extractor, not drop it. The helper only reports suspicion.
    expect(assessPdfExtractionQuality(repeatText(40, 5), 5).suspicious).toBe(
      true,
    );
  });

  it("does not judge a short document on density", () => {
    // Below the page floor the density estimate is at its weakest and a
    // short document can legitimately be sparse (a memo, a form, a title
    // page); it must not trigger a fallback run or lose its cache entry.
    expect(assessPdfExtractionQuality(repeatText(40, 1), 1).suspicious).toBe(
      false,
    );
    expect(assessPdfExtractionQuality(repeatText(40, 4), 4).suspicious).toBe(
      false,
    );
  });

  it("does not judge when the page count is unknown", () => {
    expect(
      assessPdfExtractionQuality(repeatText(10, 1), undefined).suspicious,
    ).toBe(false);
    expect(assessPdfExtractionQuality(repeatText(10, 1), 0).suspicious).toBe(
      false,
    );
  });

  it("counts non-whitespace characters only", () => {
    // 50 real chars/page padded with whitespace must still be suspicious.
    const padded = ("x".repeat(50) + " \n ".repeat(50)).repeat(10);
    expect(assessPdfExtractionQuality(padded, 10).suspicious).toBe(true);
    const dense = ("x".repeat(150) + " \n ".repeat(50)).repeat(10);
    expect(assessPdfExtractionQuality(dense, 10).suspicious).toBe(false);
  });

  it("sits exactly on the threshold boundary", () => {
    expect(
      assessPdfExtractionQuality(
        repeatText(PDF_MIN_DENSITY_CHARS_PER_PAGE, 5),
        5,
      ).suspicious,
    ).toBe(false);
    expect(
      assessPdfExtractionQuality(
        repeatText(PDF_MIN_DENSITY_CHARS_PER_PAGE - 1, 5),
        5,
      ).suspicious,
    ).toBe(true);
  });

  it("exposes the minimum page floor", () => {
    expect(PDF_MIN_PAGES_FOR_DENSITY_CHECK).toBe(5);
  });
});

describe("effectiveProcessedPages", () => {
  it("caps the page count at maxPages", () => {
    expect(effectiveProcessedPages(46, 5)).toBe(5);
    expect(effectiveProcessedPages(3, 10)).toBe(3);
  });

  it("passes the full count through when nothing is capped", () => {
    expect(effectiveProcessedPages(46, undefined)).toBe(46);
    expect(effectiveProcessedPages(undefined, 5)).toBe(undefined);
  });
});

describe("getRustPdfIneligibleReason", () => {
  it("accepts a healthy dense Rust result", () => {
    expect(getRustPdfIneligibleReason(rustResult({}), 10)).toBeNull();
  });

  it("rejects the reported degenerate Rust result on density", () => {
    const reason = getRustPdfIneligibleReason(
      rustResult({ markdown: repeatText(67, 46), pageCount: 46 }),
      46,
    );
    expect(reason).toMatch(/suspected incomplete/);
    expect(reason).toMatch(/67/);
  });

  it("does not flag the same markdown when only 5 pages were processed", () => {
    // maxPages=5: the extractor only ran over 5 pages, so 3,096 chars is
    // dense for what was processed. The denominator must be the effective
    // processed pages, not the document total.
    expect(
      getRustPdfIneligibleReason(
        rustResult({ markdown: repeatText(67, 46), pageCount: 46 }),
        5,
      ),
    ).toBeNull();
  });

  it("keeps the pre-existing eligibility checks", () => {
    expect(
      getRustPdfIneligibleReason(rustResult({ pdfType: "Scanned" }), 10),
    ).toMatch(/pdfType=Scanned/);
    expect(
      getRustPdfIneligibleReason(rustResult({ confidence: 0.5 }), 10),
    ).toMatch(/confidence=0.5/);
    expect(
      getRustPdfIneligibleReason(rustResult({ isComplex: true }), 10),
    ).toMatch(/complex layout/);
    expect(
      getRustPdfIneligibleReason(rustResult({ markdown: "" }), 10),
    ).toMatch(/empty markdown/);
  });

  it("rejects whitespace-only markdown as empty", () => {
    // No visible text is empty for eligibility purposes: the density
    // helper deliberately does not judge a zero-character result, so a
    // whitespace-only TextBased result would otherwise be adopted as-is
    // and skip the fallback chain.
    expect(
      getRustPdfIneligibleReason(rustResult({ markdown: "   \n\t  " }), 10),
    ).toMatch(/empty markdown/);
  });

  it("keeps a whitespace-padded dense result eligible", () => {
    expect(
      getRustPdfIneligibleReason(
        rustResult({ markdown: "  \n" + "x".repeat(10_000) }),
        10,
      ),
    ).toBeNull();
  });

  it("does not judge density when the effective page count is unknown", () => {
    expect(
      getRustPdfIneligibleReason(
        rustResult({ markdown: repeatText(10, 1), pageCount: 46 }),
        undefined,
      ),
    ).toBeNull();
  });
});

describe("pickRicherPdfResult", () => {
  it("keeps the longer extraction", () => {
    const sparse = processorResult("x".repeat(100));
    const rich = processorResult("x".repeat(10_000));
    expect(pickRicherPdfResult(sparse, rich)).toBe(rich);
    expect(pickRicherPdfResult(rich, sparse)).toBe(rich);
  });

  it("keeps the first result on a tie", () => {
    const a = processorResult("x".repeat(100));
    const b = processorResult("x".repeat(100));
    expect(pickRicherPdfResult(a, b)).toBe(a);
  });

  it("tolerates missing candidates", () => {
    const rich = processorResult("x".repeat(100));
    expect(pickRicherPdfResult(null, rich)).toBe(rich);
    expect(pickRicherPdfResult(rich, null)).toBe(rich);
    expect(pickRicherPdfResult(null, null)).toBeNull();
  });

  it("compares non-whitespace characters, not raw length", () => {
    const padded = processorResult("x".repeat(100) + " ".repeat(10_000));
    const dense = processorResult("x".repeat(200));
    expect(pickRicherPdfResult(padded, dense)).toBe(dense);
  });
});
