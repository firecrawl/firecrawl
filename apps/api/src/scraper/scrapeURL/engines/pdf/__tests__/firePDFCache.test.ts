import {
  getPdfResultFromCache,
  pdfCacheConfigured,
  savePdfResultToCache,
} from "../../../../../lib/gcs-pdf-cache";
import {
  cacheKeyShape,
  maybeSaveResult,
  provenanceFromResponse,
  tryGetCached,
} from "../fire-pdf/cache";
import { consumeRefresh, refreshDecisionFor } from "../fire-pdf/refresh-budget";
import { firePdfProvenanceSchema } from "../fire-pdf/schema";
import {
  firePdfCacheEventsTotal,
  firePdfCacheRefusedWritesTotal,
} from "../fire-pdf/metrics";
import crypto from "crypto";
import { config } from "../../../../../config";
import { robustFetch } from "../../../lib/fetch";

vi.mock("../fire-pdf/refresh-budget", () => ({
  consumeRefresh: vi.fn(async () => "allowed"),
  refreshDecisionFor: vi.fn(() => undefined),
}));

vi.mock("../../../lib/fetch", () => ({ robustFetch: vi.fn() }));
vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

vi.mock("../../../../../lib/gcs-pdf-cache", async () => {
  const { createHash } = await import("crypto");
  return {
    pdfCacheConfigured: vi.fn(() => true),
    getPdfResultFromCache: vi.fn(),
    savePdfResultToCache: vi.fn(),
    resolvePdfCacheKey: vi.fn((input: string | { key: string }) =>
      typeof input === "string" ? `key-of-${input}` : input.key,
    ),
    createPdfCacheKey: (input: string) =>
      createHash("sha256").update(input).digest("hex"),
  };
});

const getCached = vi.mocked(getPdfResultFromCache);
const saveCached = vi.mocked(savePdfResultToCache);

function makeMeta(zeroDataRetention = false, parsers?: unknown[]) {
  return {
    id: "page-cache-test",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    internalOptions: { zeroDataRetention },
    ...(parsers ? { options: { parsers } } : {}),
  } as any;
}

const provenance = {
  generation: "2026-09-16.1",
  build_sha: "25c376ac15489dc6d5cab9af8728de41357ffc69",
  built_at: "2026-09-17T20:11:39Z",
  produced_at: "2026-09-17T20:12:00.000Z",
  stages: ["native_text", "layout", "ocr"],
  quality: {
    total_pages: 3,
    failed_pages: 0,
    partial_pages: 0,
    degraded_pages: 0,
    ocr_pages: 1,
  },
};

describe("FirePDF page-markdown cache capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(null);
    // The real save returns the cache key on success and null when it could
    // not persist; a null default would read as "not written".
    saveCached.mockResolvedValue("saved-key");
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

describe("FirePDF cache and empty raster-image results", () => {
  // Base64 of a PNG signature followed by padding: sniffs as image/png.
  const PNG_BASE64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]).toString("base64");
  // Base64 of "%PDF-1.7": not an image, so the PDF rules apply.
  const PDF_BASE64 = Buffer.from(
    "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
    "latin1",
  ).toString("base64");

  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(null);
    // The real save returns the cache key on success and null when it could
    // not persist; a null default would read as "not written".
    saveCached.mockResolvedValue("saved-key");
  });

  it("treats a cached empty result for an image as a miss", async () => {
    getCached.mockResolvedValue({ markdown: "", html: "" });
    const meta = makeMeta();

    const result = await tryGetCached(
      meta,
      PNG_BASE64,
      "ocr",
      undefined,
      1,
      false,
      false,
    );

    expect(result).toBeNull();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Ignoring cached empty FirePDF result for a raster image",
      expect.objectContaining({ cacheVariant: "ocr" }),
    );
  });

  it("still serves a cached image result that has text", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "# Title",
      html: "<h1>Title</h1>",
    });

    const result = await tryGetCached(
      makeMeta(),
      PNG_BASE64,
      "ocr",
      undefined,
      1,
      false,
      false,
    );

    expect(result).toMatchObject({ markdown: "# Title" });
  });

  it("keeps serving cached empty results for PDFs", async () => {
    getCached.mockResolvedValueOnce({ markdown: "", html: "" });

    const result = await tryGetCached(
      makeMeta(),
      PDF_BASE64,
      "auto",
      undefined,
      1,
      false,
      false,
    );

    expect(result).toMatchObject({ markdown: "", html: "" });
  });

  it("never writes an empty image result, but writes empty PDF and non-empty image results", async () => {
    const save = (base64Content: string, markdown: string) =>
      maybeSaveResult({
        meta: makeMeta(),
        base64Content,
        mode: "ocr",
        maxPages: undefined,
        includePageMarkdown: false,
        includeBlocks: false,
        result: {
          markdown,
          html: markdown ? `<p>${markdown}</p>` : "",
          pagesProcessed: 1,
        },
      });

    await save(PNG_BASE64, "");
    expect(saveCached).not.toHaveBeenCalled();

    await save(PNG_BASE64, "   \n");
    expect(saveCached).not.toHaveBeenCalled();

    await save(PDF_BASE64, "");
    expect(saveCached).toHaveBeenCalledTimes(1);

    await save(PNG_BASE64, "text");
    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached).toHaveBeenLastCalledWith(
      PNG_BASE64,
      expect.objectContaining({ markdown: "text" }),
      "firepdf",
      "ocr",
    );
  });
});

describe("FirePDF cache provenance and write rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(null);
    // The real save returns the cache key on success and null when it could
    // not persist; a null default would read as "not written".
    saveCached.mockResolvedValue("saved-key");
  });

  it("stores the stamp, the write time and the variant with the entry", async () => {
    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>", pagesProcessed: 3 },
      provenance,
      failedPages: null,
    });

    expect(saveCached).toHaveBeenCalledTimes(1);
    const entry = saveCached.mock.calls[0][1];
    expect(entry).toMatchObject({
      markdown: "whole",
      provenance,
      variant: "base",
    });
    expect(typeof entry.cachedAt).toBe("string");
    expect(Number.isNaN(Date.parse(entry.cachedAt!))).toBe(false);
  });

  it("stamps the compact legacy entry it back-fills beside a sidecar", async () => {
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
        pageMarkdown: [{ page: 1, markdown: "one" }],
      },
      provenance,
    });

    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached.mock.calls[0][1]).toMatchObject({
      provenance,
      variant: "page-markdown-v1",
    });
    expect(saveCached.mock.calls[1][1]).toMatchObject({
      provenance,
      variant: "base",
    });
  });

  it("writes entries without a stamp when fire-pdf sent none", async () => {
    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
    });
    expect(saveCached).toHaveBeenCalledTimes(1);
    expect(saveCached.mock.calls[0][1]).not.toHaveProperty("provenance");
    expect(saveCached.mock.calls[0][1]).toMatchObject({ variant: "base" });
  });

  it("does not cache a result with failed pages, and says why", async () => {
    const meta = makeMeta();
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "most of it", html: "<p>most of it</p>" },
      provenance,
      failedPages: [4],
    });
    expect(saveCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "FirePDF result not cached",
      expect.objectContaining({
        reason: "failed_pages",
        cacheKey: "key-of-BASE64",
      }),
    );
  });

  it("does not cache a result whose pages lost layout (degraded), but does cache partial pages", async () => {
    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "text only", html: "<p>text only</p>" },
      provenance: {
        ...provenance,
        quality: { ...provenance.quality, degraded_pages: 2 },
      },
      failedPages: null,
    });
    expect(saveCached).not.toHaveBeenCalled();

    await maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "nearly all", html: "<p>nearly all</p>" },
      provenance: {
        ...provenance,
        quality: { ...provenance.quality, partial_pages: 1 },
      },
      failedPages: null,
    });
    expect(saveCached).toHaveBeenCalledTimes(1);
    expect(saveCached.mock.calls[0][1]).toMatchObject({
      provenance: expect.objectContaining({
        quality: expect.objectContaining({ partial_pages: 1 }),
      }),
    });
  });

  it("serves a stamped entry without leaking the bookkeeping fields, and logs the key and generation", async () => {
    getCached.mockResolvedValueOnce({
      markdown: "whole",
      html: "<p>whole</p>",
      pagesProcessed: 3,
      provenance,
      cachedAt: "2026-09-17T20:12:01.000Z",
      variant: "base",
    });
    const meta = makeMeta();
    const result = await tryGetCached(
      meta,
      "BASE64",
      "auto",
      undefined,
      undefined,
      false,
      false,
    );
    expect(result).toEqual({
      markdown: "whole",
      html: "<p>whole</p>",
      pagesProcessed: 3,
    });
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Using cached FirePDF result",
      expect.objectContaining({
        cacheKey: "key-of-BASE64",
        generation: "2026-09-16.1",
        buildSha: provenance.build_sha,
        cachedAt: "2026-09-17T20:12:01.000Z",
      }),
    );
  });

  it("reads an entry written before the stamp existed as unknown provenance", async () => {
    getCached.mockResolvedValueOnce({ markdown: "old", html: "<p>old</p>" });
    const meta = makeMeta();
    await tryGetCached(meta, "BASE64", "auto", undefined, 1, false, false);
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Using cached FirePDF result",
      expect.objectContaining({
        generation: "unknown",
        buildSha: "unknown",
        cachedAt: null,
      }),
    );
  });

  it("bypasses the read, but not the write, when the pdf parser asks for a refresh", async () => {
    getCached.mockResolvedValue({ markdown: "stale", html: "<p>stale</p>" });
    const meta = makeMeta(false, [{ type: "pdf", refresh: true }]);
    const result = await tryGetCached(
      meta,
      "BASE64",
      "auto",
      undefined,
      1,
      false,
      false,
    );
    expect(result).toBeNull();
    expect(getCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "FirePDF cache bypassed by refresh",
      expect.objectContaining({ cacheKey: "key-of-BASE64" }),
    );

    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "fresh", html: "<p>fresh</p>" },
      provenance,
    });
    expect(saveCached).toHaveBeenCalledTimes(1);
  });

  it("serves the cache normally when the team's refresh budget is spent, and says so", async () => {
    vi.mocked(consumeRefresh).mockResolvedValueOnce("limited");
    getCached.mockResolvedValue({ markdown: "cached", html: "<p>cached</p>" });
    const meta = makeMeta(false, [{ type: "pdf", refresh: true }]);
    const result = await tryGetCached(
      meta,
      "BASE64",
      "auto",
      undefined,
      1,
      false,
      false,
    );
    expect(result?.markdown).toBe("cached");
    expect(getCached).toHaveBeenCalled();
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "FirePDF cache refresh not applied",
      expect.objectContaining({
        decision: "limited",
        cacheKey: "key-of-BASE64",
      }),
    );
  });
  it("does not report a write the cache layer could not persist", async () => {
    saveCached.mockResolvedValueOnce(null);
    const meta = makeMeta();
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
      provenance,
    });
    expect(saveCached).toHaveBeenCalledTimes(1);
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "FirePDF result not persisted to cache",
      expect.objectContaining({ cacheKey: "key-of-BASE64" }),
    );
    expect(meta.logger.info).not.toHaveBeenCalledWith(
      "Saved FirePDF result to cache",
      expect.anything(),
    );
  });

  it("refuses a result whose stamp reports failed pages when the list is absent", async () => {
    const meta = makeMeta();
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
      provenance: {
        ...provenance,
        quality: { ...provenance.quality, failed_pages: 2 },
      },
      failedPages: undefined,
    });
    expect(saveCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "FirePDF result not cached",
      expect.objectContaining({ reason: "failed_pages", failedPages: 2 }),
    );
  });

  it("refuses a result whose stamp could not be read", async () => {
    const meta = makeMeta();
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
      provenance: null,
      failedPages: [],
    });
    expect(saveCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "FirePDF result not cached",
      expect.objectContaining({ reason: "malformed_provenance" }),
    );
  });

  it("reads the stamp apart from the document and never throws", () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    const context = { scrapeId: "s1", cacheKey: "key-of-BASE64" };
    expect(provenanceFromResponse(provenance, logger, context)).toEqual(
      provenance,
    );
    expect(provenanceFromResponse(undefined, logger, context)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(
      provenanceFromResponse(
        {
          ...provenance,
          quality: { ...provenance.quality, failed_pages: "2" },
        },
        logger,
        context,
      ),
    ).toBeNull();
    expect(provenanceFromResponse("garbage", logger, context)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "FirePDF provenance stamp not understood",
      expect.objectContaining({
        cacheKey: "key-of-BASE64",
        issue: expect.stringContaining("quality.failed_pages"),
      }),
    );
  });

  it("rewrites the base alias on an allowed refresh even when one exists", async () => {
    vi.mocked(refreshDecisionFor).mockReturnValueOnce("allowed");
    const meta = makeMeta(false, [{ type: "pdf", refresh: true }]);
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: true,
      includeBlocks: false,
      result: {
        markdown: "fresh",
        html: "<p>fresh</p>",
        pageMarkdown: [{ page: 1, markdown: "fresh" }],
      },
      provenance,
    });
    // No read of the existing alias: it is overwritten regardless.
    expect(getCached).not.toHaveBeenCalled();
    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(saveCached).toHaveBeenLastCalledWith(
      "BASE64",
      expect.objectContaining({ markdown: "fresh", variant: "base" }),
      "firepdf",
      undefined,
    );
  });

  it("refuses a stamped result that carries no quality counts", async () => {
    const meta = makeMeta();
    const { quality: _quality, ...withoutQuality } = provenance;
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
      provenance: withoutQuality,
      failedPages: [],
    });
    expect(saveCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "FirePDF result not cached",
      expect.objectContaining({ reason: "missing_quality" }),
    );
  });

  it("treats an explicit null stamp as unreadable, not as absent", () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    expect(
      provenanceFromResponse(null, logger, {
        scrapeId: "s1",
        cacheKey: "key-of-BASE64",
      }),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "FirePDF provenance stamp not understood",
      expect.objectContaining({ issue: expect.stringContaining("null") }),
    );
  });

  it("keeps fields a newer fire-pdf adds to a contributing build", () => {
    const parsed = firePdfProvenanceSchema.parse({
      ...provenance,
      contributing_builds: [
        {
          generation: "2026-09-16.1",
          build_sha: "abc",
          built_at: null,
          lane: "heavy",
        },
      ],
    });
    expect(parsed.contributing_builds?.[0]).toMatchObject({ lane: "heavy" });
  });

  it("logs an alias write the cache layer could not persist", async () => {
    saveCached.mockResolvedValueOnce("saved-key").mockResolvedValueOnce(null);
    const meta = makeMeta();
    await maybeSaveResult({
      meta,
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: true,
      includeBlocks: false,
      result: {
        markdown: "whole",
        html: "<p>whole</p>",
        pageMarkdown: [{ page: 1, markdown: "whole" }],
      },
      provenance,
    });
    expect(saveCached).toHaveBeenCalledTimes(2);
    expect(meta.logger.info).toHaveBeenCalledWith(
      "Saved FirePDF result to cache",
      expect.objectContaining({
        cacheVariant: "page-markdown-v1",
        alias: false,
        cacheKey: "key-of-BASE64",
      }),
    );
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "FirePDF result not persisted to cache",
      expect.objectContaining({
        cacheVariant: "base",
        alias: true,
        cacheKey: "key-of-BASE64",
      }),
    );
  });

  it("rejects a stamp whose page counts are negative or fractional", () => {
    expect(firePdfProvenanceSchema.safeParse(provenance).success).toBe(true);
    for (const bad of [
      { ...provenance.quality, degraded_pages: -1 },
      { ...provenance.quality, failed_pages: 0.5 },
    ]) {
      expect(
        firePdfProvenanceSchema.safeParse({ ...provenance, quality: bad })
          .success,
      ).toBe(false);
    }
  });
});

// The counters are the headline deliverable: spy on the real prom-client
// counters so a change to an event name, a label or a refusal reason fails
// here instead of silently on a dashboard.
describe("FirePDF cache counters", () => {
  const events = vi.spyOn(firePdfCacheEventsTotal, "inc");
  const refused = vi.spyOn(firePdfCacheRefusedWritesTotal, "inc");

  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(null);
    saveCached.mockResolvedValue("saved-key");
    vi.mocked(consumeRefresh).mockResolvedValue("allowed");
  });

  const save = (
    overrides: Partial<Parameters<typeof maybeSaveResult>[0]> = {},
  ) =>
    maybeSaveResult({
      meta: makeMeta(),
      base64Content: "BASE64",
      mode: "auto",
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "whole", html: "<p>whole</p>" },
      provenance,
      failedPages: [],
      ...overrides,
    });

  const read = (meta = makeMeta()) =>
    tryGetCached(meta, "BASE64", "auto", undefined, 1, false, false);

  it("counts a persisted write, and a write that was not persisted", async () => {
    await save();
    expect(events).toHaveBeenCalledWith({ event: "write", variant: "base" });
    saveCached.mockResolvedValueOnce(null);
    await save();
    expect(events).toHaveBeenCalledWith({
      event: "write_failed",
      variant: "base",
    });
  });

  it("counts the alias write under its own variant", async () => {
    saveCached.mockResolvedValueOnce("saved-key").mockResolvedValueOnce(null);
    await save({
      includePageMarkdown: true,
      result: {
        markdown: "whole",
        html: "<p>whole</p>",
        pageMarkdown: [{ page: 1, markdown: "whole" }],
      },
    });
    expect(events).toHaveBeenCalledWith({
      event: "write",
      variant: "page-markdown-v1",
    });
    expect(events).toHaveBeenCalledWith({
      event: "write_failed",
      variant: "base",
    });
  });

  it("counts every refusal reason", async () => {
    await save({ failedPages: [2] });
    await save({
      provenance: {
        ...provenance,
        quality: { ...provenance.quality, degraded_pages: 1 },
      },
    });
    const { quality: _quality, ...withoutQuality } = provenance;
    await save({ provenance: withoutQuality });
    await save({ provenance: null });
    for (const reason of [
      "failed_pages",
      "degraded_pages",
      "missing_quality",
      "malformed_provenance",
    ]) {
      expect(refused).toHaveBeenCalledWith({ reason });
    }
    expect(
      events.mock.calls.filter(
        ([labels]) => (labels as { event?: string }).event === "refused_write",
      ),
    ).toHaveLength(4);
    expect(saveCached).not.toHaveBeenCalled();
  });

  it("does nothing, and counts nothing, when no cache is configured", async () => {
    vi.mocked(pdfCacheConfigured).mockReturnValue(false);
    try {
      const meta = makeMeta(false, [{ type: "pdf", refresh: true }]);
      await expect(read(meta)).resolves.toBeNull();
      await save({ meta });
      expect(getCached).not.toHaveBeenCalled();
      expect(saveCached).not.toHaveBeenCalled();
      expect(consumeRefresh).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      vi.mocked(pdfCacheConfigured).mockReturnValue(true);
    }
  });

  it("counts hits, misses and both refresh outcomes", async () => {
    await read();
    expect(events).toHaveBeenCalledWith({ event: "miss", variant: "base" });
    getCached.mockResolvedValueOnce({ markdown: "cached", html: "<p>c</p>" });
    await read();
    expect(events).toHaveBeenCalledWith({ event: "hit", variant: "base" });
    await read(makeMeta(false, [{ type: "pdf", refresh: true }]));
    expect(events).toHaveBeenCalledWith({
      event: "bypass_refresh",
      variant: "base",
    });
    vi.mocked(consumeRefresh).mockResolvedValueOnce("limited");
    await read(makeMeta(false, [{ type: "pdf", refresh: true }]));
    expect(events).toHaveBeenCalledWith({
      event: "bypass_refresh_denied",
      variant: "base",
    });
  });
});

describe("FirePDF cache through the lookup service", () => {
  const fetchMock = vi.mocked(robustFetch);
  const base64 = Buffer.from("%PDF-1.7 service test").toString("base64");
  const rawKey = `raw-${crypto
    .createHash("sha256")
    .update(Buffer.from(base64, "base64"))
    .digest("hex")}`;
  const inlineKey = crypto.createHash("sha256").update(base64).digest("hex");

  function serviceMeta(parsers?: unknown[]) {
    return {
      id: "svc-test",
      logger: { info: vi.fn(), warn: vi.fn() },
      internalOptions: { zeroDataRetention: false, teamId: "team-1" },
      mock: null,
      abort: {
        asSignal: () => new AbortController().signal,
        throwIfAborted: vi.fn(),
      },
      ...(parsers ? { options: { parsers } } : {}),
    } as any;
  }
  // Base64 of a PNG signature followed by padding: sniffs as image/png.
  const PNG_BASE64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]).toString("base64");

  beforeEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache";
    fetchMock.mockReset();
    getCached.mockReset();
    saveCached.mockReset();
    vi.mocked(consumeRefresh).mockClear();
  });

  afterEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = undefined;
  });

  it("asks the service once with both keys and the options, and serves a hit without reading the bucket", async () => {
    fetchMock.mockResolvedValueOnce({
      outcome: "hit",
      key: rawKey,
      variant: "page-markdown-v1",
      result: {
        markdown: "# doc",
        pages_processed: 2,
        pages: [{ page: 1, markdown: "p1" }],
      },
    } as any);
    const result = await tryGetCached(
      serviceMeta(),
      base64,
      "auto",
      undefined,
      5,
      true,
      false,
    );
    expect(result).toEqual({
      markdown: "# doc",
      html: "<p># doc</p>",
      pagesProcessed: 2,
      pageMarkdown: [{ page: 1, markdown: "p1" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0][0];
    expect(call.url).toBe("http://cache/cache/lookup");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      keys: [rawKey, inlineKey],
      options: { mode: "auto", include_page_markdown: true },
      team_id: "team-1",
      kind: "scrape",
      refresh: false,
      source_kind: "pdf",
      scrape_id: "svc-test",
    });
    expect(getCached).not.toHaveBeenCalled();
  });

  it("uses the caller's key alone for a by-reference document", async () => {
    fetchMock.mockResolvedValueOnce({
      outcome: "miss",
      reason: "not_found",
    } as any);
    expect(
      await tryGetCached(
        serviceMeta(),
        { key: "raw-abc" },
        undefined,
        undefined,
        undefined,
        false,
        false,
      ),
    ).toBeNull();
    expect(fetchMock.mock.calls[0][0].body.keys).toEqual(["raw-abc"]);
  });

  it("serves a stale answer, and treats a failed lookup as a miss", async () => {
    fetchMock.mockResolvedValueOnce({
      outcome: "stale",
      key: inlineKey,
      variant: "base",
      campaign: "c1",
      result: { markdown: "# old" },
    } as any);
    expect(
      await tryGetCached(
        serviceMeta(),
        base64,
        undefined,
        undefined,
        3,
        false,
        false,
      ),
    ).toEqual({ markdown: "# old", html: "<p># old</p>", pagesProcessed: 3 });
    fetchMock.mockRejectedValueOnce(new Error("timed out"));
    const meta = serviceMeta();
    expect(
      await tryGetCached(meta, base64, undefined, undefined, 3, false, false),
    ).toBeNull();
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "FirePDF cache lookup failed, proceeding",
      expect.objectContaining({ scrapeId: "svc-test" }),
    );
  });

  it("passes refresh through for the service to budget", async () => {
    fetchMock.mockResolvedValueOnce({
      outcome: "miss",
      reason: "refresh",
    } as any);
    expect(
      await tryGetCached(
        serviceMeta([{ type: "pdf", refresh: true }]),
        base64,
        undefined,
        undefined,
        undefined,
        false,
        false,
      ),
    ).toBeNull();
    expect(fetchMock.mock.calls[0][0].body.refresh).toBe(true);
    expect(consumeRefresh).not.toHaveBeenCalled();
  });

  it("lets the scrape's own abort through instead of counting it as a lookup failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("aborted mid-lookup"));
    const meta = serviceMeta();
    let calls = 0;
    meta.abort.throwIfAborted.mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error("scrape aborted");
    });
    await expect(
      tryGetCached(meta, base64, undefined, undefined, undefined, false, false),
    ).rejects.toThrow("scrape aborted");
    expect(meta.logger.warn).not.toHaveBeenCalled();
  });

  it("never serves an empty result for a raster image, and names the image to the service", async () => {
    fetchMock.mockResolvedValueOnce({
      outcome: "hit",
      key: "k",
      variant: "base",
      result: { markdown: "   " },
    } as any);
    expect(
      await tryGetCached(
        serviceMeta(),
        PNG_BASE64,
        undefined,
        undefined,
        undefined,
        false,
        false,
      ),
    ).toBeNull();
    expect(fetchMock.mock.calls[0][0].body.source_kind).toBe("image");
  });

  it("does not write results itself while the service is in use", async () => {
    await maybeSaveResult({
      meta: serviceMeta(),
      base64Content: base64,
      mode: undefined,
      maxPages: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      result: { markdown: "# doc", html: "<p># doc</p>" },
      provenance: undefined,
      failedPages: [],
    });
    expect(saveCached).not.toHaveBeenCalled();
  });
});
