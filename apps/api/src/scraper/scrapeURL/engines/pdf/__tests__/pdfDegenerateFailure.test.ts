import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { scrapePDF } from "../index";
import { isExtractionQualityRejection } from "../pdfQuality";
import {
  SHORT_HEADER,
  degeneratePdf,
  makeLogger,
  makeMeta,
} from "./degeneratePdfHarness";
import { config } from "../../../../../config";

// Same mocked-download harness as pdfDegenerateFallback.test.ts: the only
// boundary mocked is the download. The pdf-parse fallback itself is
// replaced with a throwing double here, to prove a rejected Rust result is
// never silently returned when the fallback fails. The fixture builder is
// shared with that file so both tests exercise the same TextBased
// degenerate shape; the download mock stays per-file because each file's
// vi.mock factory must be top-level.
const mockState = vi.hoisted(() => ({
  pdfBytes: Buffer.alloc(0) as Buffer,
  tempPaths: [] as string[],
}));

vi.mock("../../utils/downloadFile", () => ({
  downloadFile: vi.fn(async (..._args: any[]): Promise<any> => {
    const tempFilePath = path.join(
      tmpdir(),
      `fc-degenerate-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
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

vi.mock("../pdfParse", () => ({
  PDF_PARSE_MAX_PAGES: 1000,
  scrapePDFWithParsePDF: vi.fn(async (): Promise<never> => {
    throw new Error("pdf-parse unavailable (test double)");
  }),
}));

describe("degenerate PDF fallback failure path", () => {
  let originalRustFlag: boolean | undefined;

  beforeAll(() => {
    originalRustFlag = config.PDF_RUST_EXTRACT_ENABLE;
    config.PDF_RUST_EXTRACT_ENABLE = true;
  });

  afterAll(() => {
    config.PDF_RUST_EXTRACT_ENABLE = originalRustFlag;
  });

  it("propagates the fallback error instead of silently returning rejected markdown", async () => {
    mockState.pdfBytes = degeneratePdf(5, SHORT_HEADER);
    mockState.tempPaths = [];
    const logger = makeLogger();

    await expect(scrapePDF(makeMeta(["pdf"], logger))).rejects.toThrow(
      "pdf-parse unavailable (test double)",
    );
    // The rejection event proves the native result was the intended
    // degenerate TextBased extraction and the quality gate rejected it:
    // a native processing error would log "processPdf failed" instead and
    // never reach this event, and an ImageBased shape would be rejected by
    // the pre-existing pdfType check with a different reason. Either
    // quality branch counts: this fixture's invisible text also populates
    // the detector's OCR flags, so the rejection may arrive via the
    // in-range OCR-flag check before the density check.
    const rejects = logger.events.filter(
      e => e.msg === "Rust PDF extraction rejected, falling back to PdfParse",
    );
    expect(rejects).toHaveLength(1);
    expect(
      isExtractionQualityRejection(rejects[0].fields.reason as string),
    ).toBe(true);
    expect(
      logger.events.filter(e => e.msg.startsWith("processPdf failed")),
    ).toHaveLength(0);
    // The temp file is still cleaned up when the fallback throws.
    expect(mockState.tempPaths).toHaveLength(1);
    expect(existsSync(mockState.tempPaths[0])).toBe(false);
  });
});
