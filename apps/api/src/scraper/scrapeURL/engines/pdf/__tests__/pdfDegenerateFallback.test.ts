import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { processPdf } from "@mendable/firecrawl-rs";
import { getIneligibleReason, scrapePDF } from "../index";
import { isExtractionQualityRejection } from "../pdfQuality";
import {
  SHORT_HEADER,
  SLIDE_TITLES,
  VERBOSE_HEADER,
  buildPdf,
  countOccurrences,
  degeneratePdf,
  healthyPdf,
  makeLogger,
  makeMeta,
  slidesPdf,
} from "./degeneratePdfHarness";
import { config } from "../../../../../config";

// The download is the only boundary mocked here: the native Rust extraction
// and the pdf-parse fallback both run for real. Temp files are written to
// the OS tmpdir exactly as the real downloader would, so the temp-file
// cleanup assertion observes the real finally block.
const mockState = vi.hoisted(() => ({
  pdfBytes: Buffer.alloc(0) as Buffer,
  tempPaths: [] as string[],
}));

vi.mock("../../utils/downloadFile", () => ({
  downloadFile: vi.fn(async (..._args: any[]): Promise<any> => {
    const tempFilePath = path.join(
      tmpdir(),
      `fc-degenerate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    const { writeFile: write } = await import("node:fs/promises");
    await write(tempFilePath, mockState.pdfBytes);
    mockState.tempPaths.push(tempFilePath);
    return {
      response: { url: "http://example.com/doc.pdf", status: 200 },
      tempFilePath,
    };
  }),
  fetchFileGuardingProxyFailure: vi.fn(
    async (_meta: any, fn: () => Promise<any>): Promise<any> => fn(),
  ),
  fetchFileToBuffer: vi.fn(),
}));

describe("degenerate PDF fallback (issue #5759)", () => {
  let originalRustFlag: boolean | undefined;

  beforeAll(() => {
    originalRustFlag = config.PDF_RUST_EXTRACT_ENABLE;
    config.PDF_RUST_EXTRACT_ENABLE = true;
  });

  afterAll(() => {
    config.PDF_RUST_EXTRACT_ENABLE = originalRustFlag;
  });

  it("documents the detector behavior on a 1-page white-filled form: body suppressed, gate exempt", async () => {
    const pdf = degeneratePdf(1, SHORT_HEADER);
    const dir = await import("node:fs/promises").then(m =>
      m.mkdtemp(path.join(tmpdir(), "fc-detector-")),
    );
    const filePath = path.join(dir, "doc.pdf");
    await writeFile(filePath, pdf);
    try {
      const result = await processPdf(filePath);
      expect(result.pdfType).toBe("TextBased");
      expect(result.confidence).toBe(1);
      expect(result.isComplex).toBe(false);
      expect(result.pagesNeedingOcr).toEqual([]);
      expect(result.markdown).toContain("Municipal Gazette of Estancia");
      // The white-filled body text is suppressed by the detector.
      expect(result.markdown).not.toContain("The council approved");
      // ...but a 1-page document is exempt from the density gate.
      expect(getIneligibleReason(result, 1)).toBe(null);
      expect(getIneligibleReason(result)).toBe(null);
    } finally {
      await import("node:fs/promises").then(m =>
        m.rm(dir, { recursive: true }),
      );
    }
  });

  it("rejects a 5-page white-filled document and recovers the body via pdf-parse", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER);
    mockState.tempPaths = [];
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    expect((result.markdown ?? "").length).toBeGreaterThan(1000);

    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(
      isExtractionQualityRejection(rejects[0].fields.reason as string),
    ).toBe(true);
    expect(rejects[0].fields.effectivePages).toBe(5);
    expect(typeof rejects[0].fields.residualAlnum).toBe("number");
    // The rejection event carries counts only — never body text.
    expect(JSON.stringify(rejects[0].fields)).not.toContain(
      "The council approved",
    );

    // The downloaded temp file is cleaned up on the rejection path.
    expect(mockState.tempPaths).toHaveLength(1);
    expect(existsSync(mockState.tempPaths[0])).toBe(false);

    // The permit was released: a follow-up scrape completes.
    mockState.pdfBytes = healthyPdf(3);
    const followUp = await scrapePDF(makeMeta(["pdf"], makeLogger()));
    expect(followUp.markdown).toContain("The council approved the budget");
  });

  it("rejects a verbose-header degenerate via the density check specifically", async () => {
    mockState.pdfBytes = degeneratePdf(5, VERBOSE_HEADER);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0].fields.reason).toBe("sparse extraction");
    expect(rejects[0].fields.residualAlnum as number).toBeLessThan(400);
  });

  it("keeps the Rust extraction for a black-filled document and does not fall back", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER, "black");
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("The council approved the budget");
    // Rust's boilerplate filter keeps the repeated header once; pdf-parse
    // would repeat it on every page — so once means no fallback ran.
    expect(
      countOccurrences(result.markdown ?? "", "Municipal Gazette of Estancia"),
    ).toBe(1);
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("accepts a legit-sparse slide deck", async () => {
    mockState.pdfBytes = slidesPdf(10);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    for (const title of SLIDE_TITLES) {
      expect(result.markdown).toContain(title);
    }
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("accepts a 1-page sparse flyer", async () => {
    mockState.pdfBytes = buildPdf([
      { direct: ["Grand Opening Sale This Weekend Only", "Visit our store"] },
    ]);
    const logger = makeLogger();
    const result = await scrapePDF(makeMeta(["pdf"], logger));

    expect(result.markdown).toContain("Grand Opening Sale");
    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
  });

  it("recovers a degenerate document in fast mode without the OCR error", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER);
    const logger = makeLogger();
    const result = await scrapePDF(
      makeMeta([{ type: "pdf", mode: "fast" }], logger),
    );

    expect(result.markdown).toContain("The council approved the budget");
    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0].fields.mode).toBe("fast");
  });

  it("honors maxPages: a 20-page document capped at 2 pages is exempt", async () => {
    mockState.pdfBytes = healthyPdf(20);
    const logger = makeLogger();
    const result = await scrapePDF(
      makeMeta([{ type: "pdf", maxPages: 2 }], logger),
    );

    expect(
      logger.events.filter(
        e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
      ),
    ).toHaveLength(0);
    expect(result.markdown).toContain("The council approved the budget");
    // Sentences first appearing on page 3+ are not extracted (sentence 14
    // first appears on page 3 under the rotation used by the fixture).
    expect(result.markdown).not.toContain(
      "Health workers began the vaccination drive",
    );
    expect(result.pdfMetadata?.numPages).toBe(2);
    expect(result.pdfMetadata?.totalPages).toBe(20);
  });
});
