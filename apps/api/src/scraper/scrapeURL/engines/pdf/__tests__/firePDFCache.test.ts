import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../../lib/gcs-pdf-cache";
import {
  cacheKeyShape,
  maybeSaveResult,
  tryGetCached,
} from "../fire-pdf/cache";

vi.mock("../../../../../lib/gcs-pdf-cache", () => ({
  getPdfResultFromCache: vi.fn(),
  savePdfResultToCache: vi.fn(),
}));

const getCached = vi.mocked(getPdfResultFromCache);
const saveCached = vi.mocked(savePdfResultToCache);

function makeMeta(zeroDataRetention = false) {
  return {
    id: "page-cache-test",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    internalOptions: { zeroDataRetention },
  } as any;
}

describe("FirePDF page-markdown cache capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(null);
    saveCached.mockResolvedValue(null);
  });

  it("uses versioned page-capable variants", () => {
    expect(cacheKeyShape("auto", undefined, true, false)).toMatchObject({
      cacheable: true,
      ownVariant: "page-markdown-v1",
      lookupVariants: [
        "page-markdown-v1",
        "page-markdown-blocks-v1",
        "ocr-page-markdown-v1",
        "ocr-page-markdown-blocks-v1",
      ],
    });
    expect(cacheKeyShape("ocr", undefined, true, false)).toMatchObject({
      cacheable: true,
      ownVariant: "ocr-page-markdown-v1",
      lookupVariants: ["ocr-page-markdown-v1", "ocr-page-markdown-blocks-v1"],
    });
    expect(cacheKeyShape("fast", undefined, true, false).cacheable).toBe(false);
    expect(cacheKeyShape("auto", 5, true, false).cacheable).toBe(false);
  });

  it("uses versioned block-capable variants", () => {
    expect(cacheKeyShape("auto", undefined, false, true)).toMatchObject({
      cacheable: true,
      ownVariant: "blocks-v1",
      lookupVariants: [
        "blocks-v1",
        "page-markdown-blocks-v1",
        "ocr-blocks-v1",
        "ocr-page-markdown-blocks-v1",
      ],
    });
    expect(cacheKeyShape("ocr", undefined, false, true)).toMatchObject({
      cacheable: true,
      ownVariant: "ocr-blocks-v1",
      lookupVariants: ["ocr-blocks-v1", "ocr-page-markdown-blocks-v1"],
    });
    expect(cacheKeyShape("auto", undefined, true, true)).toMatchObject({
      cacheable: true,
      ownVariant: "page-markdown-blocks-v1",
      lookupVariants: [
        "page-markdown-blocks-v1",
        "ocr-page-markdown-blocks-v1",
      ],
    });
    expect(cacheKeyShape("fast", undefined, false, true).cacheable).toBe(false);
    expect(cacheKeyShape("auto", 5, false, true).cacheable).toBe(false);
  });

  it("maps page-marker requests into a fully disjoint variant family", () => {
    // pageMarkers rewrites the markdown itself, so no marker lookup may ever
    // name a non-marker variant (and vice versa — see the plain-request test:
    // its probe list is unchanged and marker-free).
    expect(cacheKeyShape("auto", undefined, false, false, true)).toMatchObject({
      cacheable: true,
      ownVariant: "markers-v1",
      baseVariant: "markers-v1",
      lookupVariants: [
        "markers-v1",
        "page-markdown-markers-v1",
        "ocr-markers-v1",
        "ocr-page-markdown-markers-v1",
      ],
    });
    expect(cacheKeyShape("ocr", undefined, false, false, true)).toMatchObject({
      cacheable: true,
      ownVariant: "ocr-markers-v1",
      lookupVariants: ["ocr-markers-v1", "ocr-page-markdown-markers-v1"],
    });
    expect(cacheKeyShape("auto", undefined, false, true, true)).toMatchObject({
      cacheable: true,
      ownVariant: "blocks-markers-v1",
      baseVariant: "markers-v1",
      lookupVariants: [
        "blocks-markers-v1",
        "page-markdown-blocks-markers-v1",
        "ocr-blocks-markers-v1",
        "ocr-page-markdown-blocks-markers-v1",
      ],
    });
    expect(cacheKeyShape("fast", undefined, false, false, true).cacheable).toBe(
      false,
    );
    expect(cacheKeyShape("auto", 5, false, false, true).cacheable).toBe(false);
  });

  it("keeps the historical probe list for plain requests", () => {
    expect(cacheKeyShape("auto", undefined, false, false)).toMatchObject({
      cacheable: true,
      ownVariant: undefined,
      lookupVariants: [
        undefined,
        "page-markdown-v1",
        "ocr",
        "ocr-page-markdown-v1",
      ],
    });
    expect(cacheKeyShape("ocr", undefined, false, false)).toMatchObject({
      cacheable: true,
      ownVariant: "ocr",
      lookupVariants: ["ocr", "ocr-page-markdown-v1"],
    });
  });

  it("never serves a document-only cache entry to a page-aware request", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "legacy",
      html: "<p>legacy</p>",
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "ocr",
      undefined,
      2,
      true,
      false,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(2);
    expect(getCached).toHaveBeenNthCalledWith(
      1,
      "BASE64",
      "firepdf",
      "ocr-page-markdown-v1",
    );
    expect(getCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      "firepdf",
      "ocr-page-markdown-blocks-v1",
    );
  });

  it("rejects malformed page payloads in page-capable variants", async () => {
    getCached
      .mockResolvedValueOnce({
        markdown: "wrong type",
        html: "<p>wrong type</p>",
        pageMarkdown: "not-an-array" as never,
      })
      .mockResolvedValueOnce({
        markdown: "wrong item",
        html: "<p>wrong item</p>",
        pageMarkdown: [{ page: 0, markdown: 42 }] as never,
      });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      2,
      true,
      false,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(4);
  });

  it("rejects page-capable variants missing required document fields", async () => {
    getCached
      .mockResolvedValueOnce({
        html: "<p>missing markdown</p>",
        pageMarkdown: [{ page: 1, markdown: "one" }],
      } as never)
      .mockResolvedValueOnce({
        markdown: "missing html",
        pageMarkdown: [{ page: 1, markdown: "one" }],
      } as never);

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      1,
      true,
      false,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(4);
  });

  it("accepts an explicitly empty cached markdown string", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "",
      html: "",
      pageMarkdown: [{ page: 1, markdown: "" }],
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      1,
      true,
      false,
    );

    expect(result).toMatchObject({ markdown: "", html: "" });
  });

  it("rejects invalid cached page counts", async () => {
    getCached
      .mockResolvedValueOnce({
        markdown: "wrong type",
        html: "<p>wrong type</p>",
        pagesProcessed: "1",
        pageMarkdown: [{ page: 1, markdown: "one" }],
      } as never)
      .mockResolvedValueOnce({
        markdown: "negative",
        html: "<p>negative</p>",
        pagesProcessed: -1,
        pageMarkdown: [{ page: 1, markdown: "one" }],
      });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      1,
      true,
      false,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(4);
  });

  it("serves page-capable entries and preserves the page-count fallback", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "whole",
      html: "<p>whole</p>",
      pageMarkdown: [
        { page: 1, markdown: "one" },
        { page: 2, markdown: "two" },
      ],
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      2,
      true,
      false,
    );

    expect(result?.pageMarkdown).toHaveLength(2);
    expect(result?.pagesProcessed).toBe(2);
  });

  it("strips page payloads when a legacy request reuses an enriched sidecar", async () => {
    getCached.mockResolvedValueOnce(null).mockResolvedValueOnce({
      markdown: "whole",
      html: "<p>whole</p>",
      pageMarkdown: [
        { page: 1, markdown: "one" },
        { page: 2, markdown: "two" },
      ],
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      2,
      false,
      false,
    );

    expect(result).toMatchObject({
      markdown: "whole",
      html: "<p>whole</p>",
      pagesProcessed: 2,
    });
    expect(result?.pageMarkdown).toBeUndefined();
    expect(getCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      "firepdf",
      "page-markdown-v1",
    );
  });

  it("never serves a block-less cache entry to a block-aware request", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "no blocks",
      html: "<p>no blocks</p>",
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "ocr",
      undefined,
      1,
      false,
      true,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(2);
    expect(getCached).toHaveBeenNthCalledWith(
      1,
      "BASE64",
      "firepdf",
      "ocr-blocks-v1",
    );
    expect(getCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      "firepdf",
      "ocr-page-markdown-blocks-v1",
    );
  });

  it("serves block-capable entries and strips payloads the request skipped", async () => {
    const blocks = [
      { page: 1, width: 800, height: 1100, status: "ok", items: [] },
    ];
    getCached.mockResolvedValueOnce(null).mockResolvedValueOnce({
      markdown: "whole",
      html: "<p>whole</p>",
      pagesProcessed: 1,
      pageMarkdown: [{ page: 1, markdown: "one" }],
      blocks,
    });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      1,
      false,
      true,
    );

    expect(getCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      "firepdf",
      "page-markdown-blocks-v1",
    );
    expect(result?.blocks).toEqual(blocks);
    expect(result?.pageMarkdown).toBeUndefined();
  });

  it("rejects malformed block payloads in block-capable variants", async () => {
    getCached
      .mockResolvedValueOnce({
        markdown: "wrong type",
        html: "<p>wrong type</p>",
        blocks: "not-an-array" as never,
      })
      .mockResolvedValueOnce({
        markdown: "wrong page",
        html: "<p>wrong page</p>",
        blocks: [{ page: 0, items: null }] as never,
      })
      .mockResolvedValueOnce({
        markdown: "wrong item",
        html: "<p>wrong item</p>",
        blocks: [
          { page: 1, width: 800, height: 1100, status: "ok", items: [null] },
        ] as never,
      });

    const result = await tryGetCached(
      makeMeta(),
      "BASE64",
      "auto",
      undefined,
      1,
      false,
      true,
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(4);
  });

  it("writes an enriched sidecar plus a compact legacy entry", async () => {
    const pageMarkdown = [
      { page: 1, markdown: "one" },
      { page: 2, markdown: "two" },
    ];

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: true,
      includeBlocks: false,
      result: {
        markdown: "whole",
        html: "<p>whole</p>",
        pagesProcessed: 2,
        pageMarkdown,
      },
    });

    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached).toHaveBeenNthCalledWith(
      1,
      "BASE64",
      expect.objectContaining({ pageMarkdown }),
      "firepdf",
      "page-markdown-v1",
    );
    expect(saveCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      expect.not.objectContaining({ pageMarkdown: expect.anything() }),
      "firepdf",
      undefined,
    );
  });

  it("does not rewrite an existing valid compact legacy entry", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "existing",
      html: "<p>existing</p>",
      pagesProcessed: 2,
    });

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: true,
      includeBlocks: false,
      result: {
        markdown: "whole",
        html: "<p>whole</p>",
        pagesProcessed: 2,
        pageMarkdown: [
          { page: 1, markdown: "one" },
          { page: 2, markdown: "two" },
        ],
      },
    });

    expect(getCached).toHaveBeenCalledWith("BASE64", "firepdf", undefined);
    expect(saveCached).toHaveBeenCalledOnce();
    expect(saveCached).toHaveBeenCalledWith(
      "BASE64",
      expect.objectContaining({ pageMarkdown: expect.any(Array) }),
      "firepdf",
      "page-markdown-v1",
    );
  });

  it("writes a block sidecar plus a compact legacy entry", async () => {
    const blocks = [
      {
        page: 1,
        width: 800,
        height: 1100,
        status: "ok",
        items: [],
      },
    ];

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: true,
      result: {
        markdown: "whole",
        html: "<p>whole</p>",
        pagesProcessed: 1,
        blocks,
      },
    });

    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached).toHaveBeenNthCalledWith(
      1,
      "BASE64",
      expect.objectContaining({ blocks }),
      "firepdf",
      "blocks-v1",
    );
    expect(saveCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      expect.not.objectContaining({ blocks: expect.anything() }),
      "firepdf",
      undefined,
    );
  });

  it("saves marker results only under marker variants (never the base key)", async () => {
    const marked = "Page 1\n\n---\n\n<!-- page 2 -->\n\nPage 2";

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      pageMarkers: true,
      result: {
        markdown: marked,
        html: "<p>marked</p>",
        pagesProcessed: 2,
      },
    });

    // Marker markdown must never back-fill the non-marker base key: a later
    // plain request would silently receive marker-mutated markdown.
    expect(saveCached).toHaveBeenCalledOnce();
    expect(saveCached).toHaveBeenCalledWith(
      "BASE64",
      expect.objectContaining({ markdown: marked }),
      "firepdf",
      "markers-v1",
    );
  });

  it("back-fills enriched marker results within the marker family only", async () => {
    const marked = "Page 1\n\n---\n\n<!-- page 2 -->\n\nPage 2";
    const blocks = [
      { page: 1, width: 800, height: 1100, status: "ok", items: [] },
    ];

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: true,
      pageMarkers: true,
      result: {
        markdown: marked,
        html: "<p>marked</p>",
        pagesProcessed: 2,
        blocks,
      },
    });

    expect(getCached).toHaveBeenCalledWith("BASE64", "firepdf", "markers-v1");
    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached).toHaveBeenNthCalledWith(
      1,
      "BASE64",
      expect.objectContaining({ blocks }),
      "firepdf",
      "blocks-markers-v1",
    );
    expect(saveCached).toHaveBeenNthCalledWith(
      2,
      "BASE64",
      expect.not.objectContaining({ blocks: expect.anything() }),
      "firepdf",
      "markers-v1",
    );
  });
});
