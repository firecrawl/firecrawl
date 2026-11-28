import { describe, it, expect } from "vitest";
import { getIneligibleReason } from "../index";
import {
  SPARSE_EXTRACTION_REASON,
  assessPdfExtractionQuality,
  computeResidualAlnum,
  findInRangeOcrFlag,
  isExtractionQualityRejection,
  ocrFlaggedReason,
} from "../pdfQuality";
import type { PdfProcessResult } from "@mendable/firecrawl-rs";

function makeResult(
  overrides: Partial<PdfProcessResult> = {},
): PdfProcessResult {
  return {
    pdfType: "TextBased",
    markdown: "Some body text on the page.",
    pageCount: 5,
    processingTimeMs: 1,
    pagesNeedingOcr: [],
    confidence: 1,
    isComplex: false,
    logs: [],
    ...overrides,
  };
}

/** Markdown whose only unique content is one line of `n` alnum chars. */
function sparseMarkdown(n: number, pages = 3): string {
  const header = "Quarterly Gazette Header";
  const unique = "a".repeat(n);
  return Array.from({ length: pages }, () => header)
    .concat([unique])
    .join("\n\n");
}

describe("computeResidualAlnum", () => {
  it("strips lines repeated on at least half the pages, digits normalized", () => {
    const markdown = Array.from(
      { length: 5 },
      (_, i) => `Municipal Bulletin Page ${i + 1} of 5 Edition 5301`,
    ).join("\n\n");
    const { rawAlnum, residualAlnum } = computeResidualAlnum(markdown, 5);
    expect(rawAlnum).toBeGreaterThan(0);
    expect(residualAlnum).toBe(0);
  });

  it("keeps lines unique to a page", () => {
    const markdown = [
      "Shared header line",
      "Shared header line",
      "A body sentence found only on this page",
    ].join("\n");
    const { residualAlnum } = computeResidualAlnum(markdown, 3);
    expect(residualAlnum).toBe("Abodysentencefoundonlyonthispage".length);
  });

  it("does not strip a single repeated line on a short document", () => {
    const markdown = "Only header text here";
    const { rawAlnum, residualAlnum } = computeResidualAlnum(markdown, 3);
    expect(residualAlnum).toBe(rawAlnum);
  });

  it("counts digits in the residual, on the original line", () => {
    const markdown = ["Report total 12345", "Unique body line here"].join("\n");
    const { residualAlnum } = computeResidualAlnum(markdown, 3);
    // "Reporttotal12345" (16) + "Uniquebodylinehere" (18): digits are
    // document content even though the repeat key normalizes them away.
    expect(residualAlnum).toBe(34);
  });

  it("does not collapse numbered body lines that differ only in digits", () => {
    const markdown = Array.from(
      { length: 5 },
      (_, i) => `Invoice ${1001 + i}`,
    ).join("\n");
    const { residualAlnum } = computeResidualAlnum(markdown, 5);
    // Five distinct lines: "Invoice" (7) + 4 digits each.
    expect(residualAlnum).toBe(55);
  });

  it("counts occurrences, not pages", () => {
    // No page boundaries reach this function (flat markdown), so the
    // repeat rule counts occurrences against half the page count: a line
    // repeated three times in one block counts the same as one repeated
    // across three pages.
    const markdown = [
      "Common label",
      "Common label",
      "Common label",
      "Unique content here",
    ].join("\n");
    const { residualAlnum } = computeResidualAlnum(markdown, 6);
    expect(residualAlnum).toBe("Uniquecontenthere".length);
  });
});

describe("assessPdfExtractionQuality", () => {
  it("flags a sparse multi-page extraction", () => {
    const quality = assessPdfExtractionQuality(sparseMarkdown(100), 5);
    expect(quality.suspicious).toBe(true);
    expect(quality.residualAlnum).toBe(100);
  });

  it("accepts a dense multi-page extraction", () => {
    // Pages vary in words, not just numbers: digit-normalized dedup must
    // not collapse genuinely distinct body text.
    const markdown = [
      "The council approved the budget for road repairs and public lighting upgrades across the northern districts",
      "Farmers requested support for irrigation systems and seed programs before the planting season begins",
      "Teachers welcomed the school lunch funding and student transport subsidies announced yesterday morning",
      "Local clinics received new equipment for maternal health services and expanded vaccination outreach",
      "Engineers presented the bridge inspection report and repair schedule for the river crossing downtown",
    ].join("\n\n");
    const quality = assessPdfExtractionQuality(markdown, 5);
    expect(quality.residualAlnum).toBeGreaterThan(400);
    expect(quality.suspicious).toBe(false);
  });

  it("exempts 1-2 page documents", () => {
    expect(
      assessPdfExtractionQuality(sparseMarkdown(10, 1), 1).suspicious,
    ).toBe(false);
    expect(
      assessPdfExtractionQuality(sparseMarkdown(10, 2), 2).suspicious,
    ).toBe(false);
  });

  it("fails open on unknown page counts and empty markdown", () => {
    expect(assessPdfExtractionQuality(sparseMarkdown(10), 0).suspicious).toBe(
      false,
    );
    expect(
      assessPdfExtractionQuality(sparseMarkdown(10), Number.NaN).suspicious,
    ).toBe(false);
    expect(assessPdfExtractionQuality("", 5).suspicious).toBe(false);
    expect(assessPdfExtractionQuality(undefined, 5).suspicious).toBe(false);
  });

  it("counts CJK ideographs as alphanumeric content", () => {
    // Ten pages of varied CJK prose at a realistic (sparse) density: the
    // ideographs must count toward the residual floor, with no weighting.
    const topics = [
      "项目管理",
      "产品研发",
      "市场推广",
      "销售业务",
      "技术支持",
      "财务管理",
      "人力资源",
      "客户服务",
      "供应链条",
      "战略规划",
    ];
    const markdown = topics
      .map(
        topic =>
          `本月${topic}工作进展顺利团队完成了重要里程碑并制定下阶段计划相关工作正在有序推进中取得了良好成效`,
      )
      .join("\n\n");
    const quality = assessPdfExtractionQuality(markdown, 10);
    expect(quality.rawAlnum).toBe(480);
    expect(quality.residualAlnum).toBe(480);
    expect(quality.suspicious).toBe(false);
  });

  it("pins the residual floor boundary: 399 flags, 400 does not", () => {
    expect(assessPdfExtractionQuality(sparseMarkdown(399), 3).suspicious).toBe(
      true,
    );
    expect(assessPdfExtractionQuality(sparseMarkdown(400), 3).suspicious).toBe(
      false,
    );
  });

  it("pins the raw-density boundary at 300 alnum/page", () => {
    // Residual 99 (< 400); raw total 900 -> exactly 300/page -> accepted.
    const atCeiling = [
      "r".repeat(267),
      "r".repeat(267),
      "r".repeat(267),
      "a".repeat(99),
    ].join("\n");
    const belowCeiling = [
      "r".repeat(266),
      "r".repeat(266),
      "r".repeat(266),
      "a".repeat(99),
    ].join("\n");
    expect(assessPdfExtractionQuality(atCeiling, 3).suspicious).toBe(false);
    expect(assessPdfExtractionQuality(belowCeiling, 3).suspicious).toBe(true);
  });
});

describe("findInRangeOcrFlag", () => {
  it("returns the first flagged page inside the extracted range", () => {
    expect(findInRangeOcrFlag([2, 4], 5)).toBe(2);
    expect(findInRangeOcrFlag([4], 5)).toBe(4);
  });

  it("ignores flags outside the range and non-positive flags", () => {
    expect(findInRangeOcrFlag([6], 5)).toBe(null);
    expect(findInRangeOcrFlag([0], 5)).toBe(null);
    expect(findInRangeOcrFlag([-1], 5)).toBe(null);
    expect(findInRangeOcrFlag([], 5)).toBe(null);
    expect(findInRangeOcrFlag(undefined, 5)).toBe(null);
  });

  it("fails open on unknown page counts", () => {
    expect(findInRangeOcrFlag([1], 0)).toBe(null);
    expect(findInRangeOcrFlag([1], Number.NaN)).toBe(null);
  });
});

describe("getIneligibleReason with extraction-quality checks", () => {
  it("keeps the classification checks first and unchanged", () => {
    expect(
      getIneligibleReason(
        makeResult({ pdfType: "Scanned", markdown: sparseMarkdown(10) }),
      ),
    ).toBe("pdfType=Scanned");
    expect(
      getIneligibleReason(
        makeResult({ confidence: 0.5, markdown: sparseMarkdown(10) }),
      ),
    ).toBe("confidence=0.5");
    expect(
      getIneligibleReason(
        makeResult({ isComplex: true, markdown: sparseMarkdown(10) }),
      ),
    ).toBe("complex layout (tables/columns)");
    expect(getIneligibleReason(makeResult({ markdown: "" }))).toBe(
      "empty markdown (unexpected for TextBased)",
    );
  });

  it("rejects sparse TextBased extractions", () => {
    expect(
      getIneligibleReason(makeResult({ markdown: sparseMarkdown(100) })),
    ).toBe(SPARSE_EXTRACTION_REASON);
  });

  it("accepts dense TextBased extractions", () => {
    const markdown = [
      "The council approved the budget for road repairs and public lighting upgrades across the northern districts",
      "Farmers requested support for irrigation systems and seed programs before the planting season begins",
      "Teachers welcomed the school lunch funding and student transport subsidies announced yesterday morning",
      "Local clinics received new equipment for maternal health services and expanded vaccination outreach",
      "Engineers presented the bridge inspection report and repair schedule for the river crossing downtown",
    ].join("\n\n");
    expect(getIneligibleReason(makeResult({ markdown }))).toBe(null);
  });

  it("rejects an in-range OCR-flagged page before the density check", () => {
    const dense = "x".repeat(5000);
    expect(
      getIneligibleReason(
        makeResult({ markdown: dense, pagesNeedingOcr: [2] }),
      ),
    ).toBe(ocrFlaggedReason(2));
  });

  it("ignores out-of-range OCR flags", () => {
    const dense = "x".repeat(5000);
    expect(
      getIneligibleReason(
        makeResult({ markdown: dense, pagesNeedingOcr: [6] }),
      ),
    ).toBe(null);
  });

  it("uses the effective page count when provided", () => {
    const markdown = sparseMarkdown(100);
    // Same markdown: exempt at 2 effective pages, suspect at 5.
    expect(
      getIneligibleReason(makeResult({ markdown, pageCount: 20 }), 2),
    ).toBe(null);
    expect(
      getIneligibleReason(makeResult({ markdown, pageCount: 20 }), 5),
    ).toBe(SPARSE_EXTRACTION_REASON);
    // OCR flags are bounded by the effective range, not the full count.
    expect(
      getIneligibleReason(
        makeResult({
          markdown: "x".repeat(5000),
          pageCount: 10,
          pagesNeedingOcr: [4],
        }),
        3,
      ),
    ).toBe(null);
    expect(
      getIneligibleReason(
        makeResult({
          markdown: "x".repeat(5000),
          pageCount: 10,
          pagesNeedingOcr: [4],
        }),
        5,
      ),
    ).toBe(ocrFlaggedReason(4));
  });

  it("defaults the range to the result page count", () => {
    expect(
      getIneligibleReason(
        makeResult({ markdown: sparseMarkdown(100), pageCount: 2 }),
      ),
    ).toBe(null);
    expect(
      getIneligibleReason(
        makeResult({ markdown: sparseMarkdown(100), pageCount: 5 }),
      ),
    ).toBe(SPARSE_EXTRACTION_REASON);
  });
});

describe("isExtractionQualityRejection", () => {
  it("recognizes both quality reasons and nothing else", () => {
    expect(isExtractionQualityRejection(SPARSE_EXTRACTION_REASON)).toBe(true);
    expect(isExtractionQualityRejection(ocrFlaggedReason(3))).toBe(true);
    expect(isExtractionQualityRejection("pdfType=Scanned")).toBe(false);
    expect(isExtractionQualityRejection("confidence=0.5")).toBe(false);
    expect(isExtractionQualityRejection(null)).toBe(false);
  });
});
