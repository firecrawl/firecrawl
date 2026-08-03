import { robustFetch } from "../../../lib/fetch";
import {
  reconcilePageCountWithFirePdf,
  scrapePDFWithFirePDF,
} from "../firePDF";

vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(),
}));

const mockedRobustFetch = vi.mocked(robustFetch);

function makeMeta() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    id: "sync-page-markdown-test",
    url: "https://example.com/file.pdf",
    rewrittenUrl: undefined,
    logger,
    mock: null,
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: {
      zeroDataRetention: true,
      teamId: "team-test",
    },
  } as any;
}

describe("reconcilePageCountWithFirePdf", () => {
  it("uses fire-pdf's count when the upstream pass left it at 0", () => {
    // The original regression: processPdf threw "Invalid PDF structure" on a
    // malformed-but-still-renderable PDF, so effectivePageCount stayed 0.
    // fire-pdf processes it successfully and reports 15 pages. Billing must
    // see 15, not 0.
    expect(reconcilePageCountWithFirePdf(0, { pagesProcessed: 15 })).toBe(15);
  });

  it("never shrinks a count that an upstream pass already established", () => {
    // detectPdf / processPdf saw 20 pages; fire-pdf was called with
    // max_pages=10 and processed 10. We must keep 20 — fire-pdf's value
    // reflects its own cap, not the true PDF length.
    expect(reconcilePageCountWithFirePdf(20, { pagesProcessed: 10 })).toBe(20);
  });

  it("keeps current when both agree", () => {
    expect(reconcilePageCountWithFirePdf(15, { pagesProcessed: 15 })).toBe(15);
  });

  it("ignores undefined pagesProcessed (older fire-pdf or stale cache)", () => {
    // No signal — preserve whatever the upstream pass set, even if 0.
    expect(
      reconcilePageCountWithFirePdf(0, { pagesProcessed: undefined }),
    ).toBe(0);
    expect(reconcilePageCountWithFirePdf(7, {})).toBe(7);
  });

  it("ignores null/undefined result (fire-pdf didn't run)", () => {
    expect(reconcilePageCountWithFirePdf(7, null)).toBe(7);
    expect(reconcilePageCountWithFirePdf(7, undefined)).toBe(7);
  });

  it("treats fire-pdf's 0 as a real value (no special-casing)", () => {
    // If fire-pdf legitimately reports 0 (empty PDF that still rendered),
    // the max() semantic preserves whatever was already there. We only
    // skip when the field is *missing*, not when it's zero.
    expect(reconcilePageCountWithFirePdf(0, { pagesProcessed: 0 })).toBe(0);
    expect(reconcilePageCountWithFirePdf(5, { pagesProcessed: 0 })).toBe(5);
  });
});

describe("scrapePDFWithFirePDF page markdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests and returns the physical page payload", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "continued paragraph",
      failed_pages: null,
      pages_processed: 2,
      pages: [
        { page: 1, markdown: "continued" },
        { page: 2, markdown: "paragraph" },
      ],
    } as any);

    const result = await scrapePDFWithFirePDF(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      "auto",
      true,
    );

    expect(mockedRobustFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ include_page_markdown: true }),
      }),
    );
    expect(result.pageMarkdown).toEqual([
      { page: 1, markdown: "continued" },
      { page: 2, markdown: "paragraph" },
    ]);
  });

  it("rejects document-only FirePDF responses for page-aware requests", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "document only",
      failed_pages: null,
      pages_processed: 1,
    } as any);

    await expect(
      scrapePDFWithFirePDF(
        makeMeta(),
        "BASE64",
        undefined,
        undefined,
        "auto",
        true,
      ),
    ).rejects.toThrow(/did not include requested physical page markdown/);
  });
});
