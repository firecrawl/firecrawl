import { createHash } from "crypto";
import { fetch as undiciFetch } from "undici";
import { config } from "../../../../../config";
import { robustFetch } from "../../../lib/fetch";
import {
  BACKGROUND_REFRESH_CRAWL_ID,
  refreshOptionsForVariant,
  submitBackgroundRefresh,
} from "../fire-pdf/background-refresh";
import { lookupCachedResult } from "../fire-pdf/cache-service";
import { firePdfCacheBackgroundRefreshTotal } from "../fire-pdf/metrics";

vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(),
}));
vi.mock("../../../lib/fetch", () => ({ robustFetch: vi.fn() }));
vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));
vi.mock("../fire-pdf/refresh-budget", () => ({
  recordRefreshDecision: vi.fn(),
}));
vi.mock("../../../../../lib/gcs-pdf-cache", async () => {
  const { createHash } = await import("crypto");
  return {
    createPdfCacheKey: (input: string) =>
      createHash("sha256").update(input).digest("hex"),
  };
});

const lookupFetch = vi.mocked(robustFetch);
const jobsFetch = vi.mocked(undiciFetch);

const base64 = Buffer.from("%PDF-1.7 background refresh").toString("base64");

function makeMeta(zeroDataRetention = false) {
  return {
    id: "user-scrape",
    url: "https://example.com/doc.pdf",
    logger: { info: vi.fn(), warn: vi.fn() },
    internalOptions: {
      zeroDataRetention,
      teamId: "team-1",
      crawlId: "user-crawl",
    },
    options: {},
    mock: null,
    abort: {
      asSignal: () => new AbortController().signal,
      throwIfAborted: vi.fn(),
    },
  } as any;
}

const lookupArgs = {
  mode: "auto" as const,
  pagesProcessed: 2,
  includePageMarkdown: true,
  includeBlocks: false,
  pageMarkers: false,
  refresh: false,
  sourceKind: "pdf" as const,
  ownVariant: "page-markdown-v1",
};

const staleAnswer = (refreshRequested?: boolean) => ({
  outcome: "stale",
  key: "raw-abc",
  variant: "page-markdown-v1",
  campaign: "c1",
  ...(refreshRequested !== undefined && {
    refresh_requested: refreshRequested,
  }),
  result: { markdown: "# old", pages: [{ page: 1, markdown: "p1" }] },
});

const staleResult = {
  markdown: "# old",
  html: "<p># old</p>",
  pagesProcessed: 2,
  pageMarkdown: [{ page: 1, markdown: "p1" }],
};

function answerWith(fixture: unknown) {
  lookupFetch.mockImplementationOnce(async ({ schema }: any) =>
    schema.parse(fixture),
  );
}

function jobsAnswer(status: number, body: unknown = {}) {
  jobsFetch.mockResolvedValueOnce({
    status,
    json: async () => body,
  } as any);
}

async function refreshCount(result: string): Promise<number> {
  const metric = await firePdfCacheBackgroundRefreshTotal.get();
  return metric.values.find(v => v.labels.result === result)?.value ?? 0;
}

// Lets the fire-and-forget submit run to completion.
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe("FirePDF cache background refresh", () => {
  beforeEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache";
    config.FIRE_PDF_BASE_URL = "http://fire-pdf";
    config.FIRE_PDF_CACHE_BACKGROUND_REFRESH = true;
    lookupFetch.mockReset();
    jobsFetch.mockReset();
    firePdfCacheBackgroundRefreshTotal.reset();
  });

  afterEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = undefined;
    config.FIRE_PDF_BASE_URL = undefined;
    config.FIRE_PDF_CACHE_BACKGROUND_REFRESH = false;
  });

  it("leaves the lookup body unchanged and submits nothing when the flag is off", async () => {
    config.FIRE_PDF_CACHE_BACKGROUND_REFRESH = false;
    answerWith(staleAnswer(true));
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    await settle();
    expect(lookupFetch.mock.calls[0][0].body).toStrictEqual({
      keys: [
        `raw-${createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex")}`,
        createHash("sha256").update(base64).digest("hex"),
      ],
      options: { mode: "auto", include_page_markdown: true },
      team_id: "team-1",
      kind: "scrape",
      refresh: false,
      source_kind: "pdf",
      scrape_id: "user-scrape",
    });
    expect(jobsFetch).not.toHaveBeenCalled();
  });

  it("asks for background refresh when the flag is on", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toBeNull();
    expect(lookupFetch.mock.calls[0][0].body).toMatchObject({
      background_refresh: true,
    });
    await settle();
    expect(jobsFetch).not.toHaveBeenCalled();
  });

  it("serves the stale entry and submits one refresh to the bulk queue", async () => {
    jobsAnswer(202, { status: "queued", lane: "fast" });
    answerWith(staleAnswer(true));
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    await settle();
    expect(jobsFetch).toHaveBeenCalledTimes(1);
    const [url, init] = jobsFetch.mock.calls[0] as any;
    expect(url).toBe("http://fire-pdf/jobs");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      pdf_b64: base64,
      source: "firecrawl",
      zdr: false,
      crawl_id: BACKGROUND_REFRESH_CRAWL_ID,
      source_endpoint: "scrape",
      source_kind: "pdf",
      options: { mode: "auto", include_page_markdown: true, refresh: true },
    });
    expect(body.options).not.toHaveProperty("pages_estimate");
    expect(body).not.toHaveProperty("team_id");
    expect(body).not.toHaveProperty("team_concurrency");
    expect(body.scrape_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.scrape_id).not.toBe("user-scrape");
    const deadlineMs = Date.parse(body.deadline_at) - Date.now();
    expect(deadlineMs).toBeGreaterThan(29 * 60 * 1_000);
    expect(deadlineMs).toBeLessThanOrEqual(30 * 60 * 1_000);
    expect(await refreshCount("submitted")).toBe(1);
  });

  it("does not submit when the service did not grant a refresh", async () => {
    answerWith(staleAnswer(false));
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    answerWith(staleAnswer());
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    await settle();
    expect(jobsFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a by-reference document", { key: "raw-abc" }, "pdf"],
    ["a raster image", base64, "image"],
  ] as const)(
    "does not offer background refresh for %s and ignores a grant",
    async (_name, input, sourceKind) => {
      answerWith(staleAnswer(true));
      await lookupCachedResult(makeMeta(), input as any, {
        ...lookupArgs,
        sourceKind,
      });
      await settle();
      expect(lookupFetch.mock.calls[0][0].body).not.toHaveProperty(
        "background_refresh",
      );
      expect(jobsFetch).not.toHaveBeenCalled();
    },
  );

  it("refreshes the variant that was served, not the one requested", async () => {
    jobsAnswer(202, { status: "queued" });
    answerWith({
      ...staleAnswer(true),
      variant: "ocr-page-markdown-blocks-v1",
      result: {
        markdown: "# old",
        pages: [{ page: 1, markdown: "p1" }],
        blocks: [],
      },
    });
    await lookupCachedResult(makeMeta(), base64, lookupArgs);
    await settle();
    const body = JSON.parse((jobsFetch.mock.calls[0] as any)[1].body);
    expect(body.options).toMatchObject({
      mode: "ocr",
      include_page_markdown: true,
      include_blocks: true,
      refresh: true,
    });
  });

  it.each([
    ["base", undefined, [undefined, false, false, false]],
    ["ocr", "auto", ["ocr", false, false, false]],
    ["page-markdown-v1", "auto", ["auto", true, false, false]],
    ["blocks-v1", undefined, [undefined, false, true, false]],
    ["ocr-page-markdown-blocks-v1", "auto", ["ocr", true, true, false]],
    ["markers-v1", "auto", ["auto", false, false, true]],
    ["ocr-page-markdown-markers-v1", "auto", ["ocr", true, false, true]],
  ] as const)(
    "maps variant %s to its job options",
    (variant, mode, [m, pages, blocks, markers]) => {
      expect(refreshOptionsForVariant(variant, mode)).toEqual({
        mode: m,
        includePageMarkdown: pages,
        includeBlocks: blocks,
        pageMarkers: markers,
      });
    },
  );

  it("serves the stale entry unaffected when the submit fails", async () => {
    jobsFetch.mockRejectedValueOnce(new Error("connection refused"));
    answerWith(staleAnswer(true));
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    jobsAnswer(503, { error: "admission_rejected" });
    answerWith(staleAnswer(true));
    expect(await lookupCachedResult(makeMeta(), base64, lookupArgs)).toEqual(
      staleResult,
    );
    await settle();
    expect(jobsFetch).toHaveBeenCalledTimes(2);
    expect(await refreshCount("submit_failed")).toBe(2);
  });

  it("skips ZDR requests and raster images", async () => {
    const args = {
      mode: undefined,
      includePageMarkdown: false,
      includeBlocks: false,
      pageMarkers: false,
    };
    expect(
      await submitBackgroundRefresh(makeMeta(true), base64, {
        ...args,
        sourceKind: "pdf",
      }),
    ).toBe("skipped_zdr");
    expect(
      await submitBackgroundRefresh(makeMeta(), base64, {
        ...args,
        sourceKind: "image",
      }),
    ).toBe("skipped_image");
    expect(jobsFetch).not.toHaveBeenCalled();
    expect(await refreshCount("skipped_zdr")).toBe(1);
    expect(await refreshCount("skipped_image")).toBe(1);
  });
});
