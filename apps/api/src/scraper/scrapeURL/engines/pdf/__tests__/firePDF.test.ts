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

describe("scrapePDFWithFirePDF typed blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests and returns the block payload", async () => {
    const blocks = [
      {
        page: 1,
        width: 800,
        height: 1100,
        status: "ok",
        items: [
          {
            id: "p1.b0",
            type: "title",
            label: "doc_title",
            bbox: [0.1, 0.05, 0.9, 0.1],
            content: "# Annual Report",
            markdown_span: [0, 15],
            reading_order: 0,
            source: "native_text",
            confidence: { layout: 0.97, ocr: null },
          },
        ],
      },
    ];
    mockedRobustFetch.mockResolvedValue({
      markdown: "# Annual Report",
      failed_pages: null,
      pages_processed: 1,
      blocks,
    } as any);

    const result = await scrapePDFWithFirePDF(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      "auto",
      false,
      true,
    );

    expect(mockedRobustFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ include_blocks: true }),
      }),
    );
    expect(
      ((mockedRobustFetch.mock.calls[0][0] as any).body as any)
        .include_page_markdown,
    ).toBeUndefined();
    expect(result.blocks).toEqual(blocks);
    expect(result.pageMarkdown).toBeUndefined();
  });

  it("rejects block-less FirePDF responses for block-aware requests", async () => {
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
        false,
        true,
      ),
    ).rejects.toThrow(/did not include requested typed blocks/);
  });
});

describe("scrapePDFWithFirePDF page markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests marker-joined markdown and returns it verbatim", async () => {
    const marked = "Page 1\n\n---\n\n<!-- page 2 -->\n\nPage 2";
    mockedRobustFetch.mockResolvedValue({
      markdown: marked,
      failed_pages: null,
      pages_processed: 2,
      page_markers: true,
    } as any);

    const result = await scrapePDFWithFirePDF(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      "auto",
      false,
      false,
      true,
    );

    expect(mockedRobustFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ page_markers: true }),
      }),
    );
    expect(result.markdown).toBe(marked);
  });

  it("does not send page_markers for plain requests", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "plain",
      failed_pages: null,
      pages_processed: 1,
    } as any);

    await scrapePDFWithFirePDF(makeMeta(), "BASE64");

    expect(
      ((mockedRobustFetch.mock.calls[0][0] as any).body as any).page_markers,
    ).toBeUndefined();
  });

  it("rejects FirePDF responses that do not acknowledge page markers", async () => {
    // An old fire-pdf build ignores the unknown `page_markers` request field
    // and returns ordinary markdown with no echo — indistinguishable from
    // marked output by content alone, so the missing echo must fail loud.
    mockedRobustFetch.mockResolvedValue({
      markdown: "Page 1\n\n---\n\nPage 2",
      failed_pages: null,
      pages_processed: 2,
    } as any);

    await expect(
      scrapePDFWithFirePDF(
        makeMeta(),
        "BASE64",
        undefined,
        undefined,
        "auto",
        false,
        false,
        true,
      ),
    ).rejects.toThrow(/did not acknowledge requested page markers/);
  });

  it("composes page_markers with include_blocks on the wire", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "Page 1\n\n---\n\n<!-- page 2 -->\n\nPage 2",
      failed_pages: null,
      pages_processed: 2,
      blocks: [],
      page_markers: true,
    } as any);

    await scrapePDFWithFirePDF(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      "auto",
      false,
      true,
      true,
    );

    expect(mockedRobustFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          include_blocks: true,
          page_markers: true,
        }),
      }),
    );
  });
});
