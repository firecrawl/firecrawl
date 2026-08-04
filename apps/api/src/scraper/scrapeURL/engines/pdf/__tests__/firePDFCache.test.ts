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
    expect(cacheKeyShape("auto", undefined, true)).toMatchObject({
      cacheable: true,
      ownVariant: "page-markdown-v1",
      lookupVariants: ["page-markdown-v1", "ocr-page-markdown-v1"],
    });
    expect(cacheKeyShape("ocr", undefined, true)).toMatchObject({
      cacheable: true,
      ownVariant: "ocr-page-markdown-v1",
      lookupVariants: ["ocr-page-markdown-v1"],
    });
    expect(cacheKeyShape("fast", undefined, true).cacheable).toBe(false);
    expect(cacheKeyShape("auto", 5, true).cacheable).toBe(false);
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
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledOnce();
    expect(getCached).toHaveBeenCalledWith(
      "BASE64",
      "firepdf",
      "ocr-page-markdown-v1",
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
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(2);
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
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(2);
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
    );

    expect(result).toBeNull();
    expect(getCached).toHaveBeenCalledTimes(2);
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
});
