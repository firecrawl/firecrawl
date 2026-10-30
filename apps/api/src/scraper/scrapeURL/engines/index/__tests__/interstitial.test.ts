vi.mock("../../../../../services", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../../../services")>()),
  getIndexFromGCS: vi.fn(),
}));
vi.mock("../../../../../db/rpc", () => ({
  queryMaxAge: vi.fn(),
  indexGetRecent5: vi.fn(),
}));
vi.mock("../../../../../services/index-cache", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../../../services/index-cache")
  >()),
  useIndexCache: true,
  useIndexNegativeCache: false,
  getCachedIndexEntries: vi.fn(async () => ({ status: "miss" })),
  upsertCachedIndexEntries: vi.fn(async () => {}),
  deleteCachedIndexEntry: vi.fn(async () => {}),
  getCachedMaxAge: vi.fn(async () => null),
  setCachedMaxAge: vi.fn(async () => {}),
}));

import { getIndexFromGCS } from "../../../../../services";
import {
  deleteCachedIndexEntry,
  getCachedIndexEntries,
} from "../../../../../services/index-cache";
import { indexGetRecent5 } from "../../../../../db/rpc";
import {
  isInterstitialPage,
  scrapeURLWithIndex,
  sendDocumentToIndex,
} from "../index";
import { IndexMissError } from "../../../error";

const productUrl = "https://www.amazon.com/dp/B000000000";
const checkpointUrl = "https://www.amazon.com/checkpoint/continue?token=abc";
const checkpointHtml =
  '<form method="POST" action="https://www.amazon.com/checkpoint/validate" id="checkpointForm"><button type="submit">Continue shopping</button></form>';
const captchaHtml =
  '<form method="get" action="/errors/validateCaptcha" name=""></form>';

function meta() {
  return {
    id: "index-interstitial",
    url: productUrl,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    internalOptions: { teamId: "team-1" },
    winnerEngine: "fire-engine;chrome-cdp",
    featureFlags: new Set(),
    options: {
      maxAge: 2 * 24 * 60 * 60 * 1000,
      mobile: false,
      blockAds: true,
      waitFor: 0,
      formats: ["markdown"],
      storeInCache: true,
    },
    imageOcrEnabled: async () => false,
  } as any;
}

describe("isInterstitialPage", () => {
  it.each([
    [checkpointUrl, "<p>product</p>"],
    ["https://www.amazon.co.uk/checkpoint/continue", undefined],
    ["https://www.amazon.com/errors/validateCaptcha", undefined],
    [productUrl, checkpointHtml],
    [productUrl, captchaHtml],
  ])("flags %s", (url, html) => {
    expect(isInterstitialPage(url, html)).toBe(true);
  });

  it.each([
    [productUrl, "<p>product</p>"],
    ["https://example.com/checkpoint/continue", checkpointHtml],
    ["https://notamazon.com/checkpoint/continue", undefined],
    [undefined, checkpointHtml],
    ["not a url", undefined],
  ])("does not flag %s", (url, html) => {
    expect(isInterstitialPage(url, html)).toBe(false);
  });
});

describe("URL index interstitial handling", () => {
  beforeEach(() => {
    vi.mocked(indexGetRecent5).mockClear();
    vi.mocked(indexGetRecent5).mockResolvedValue([
      {
        id: "row-1",
        created_at: new Date().toISOString(),
        status: 200,
        has_screenshot: false,
        has_screenshot_fullscreen: false,
        wait_time_ms: null,
      },
    ] as any);
    vi.mocked(deleteCachedIndexEntry).mockClear();
    vi.mocked(getCachedIndexEntries).mockResolvedValue({ status: "miss" });
  });

  it.each([
    ["checkpoint final URL", checkpointUrl, "<p>Continue shopping</p>"],
    ["checkpoint markers", productUrl, checkpointHtml],
  ])("does not write a page with a %s", async (_name, url, html) => {
    const document = {
      markdown: "Continue shopping",
      rawHtml: html,
      metadata: { url, sourceURL: productUrl, statusCode: 200 },
    } as any;
    const result = await sendDocumentToIndex(meta(), document);
    expect(result).toBe(document);
    expect(result.metadata.indexId).toBeUndefined();
  });

  it("reports a miss for a cached checkpoint page", async () => {
    vi.mocked(getIndexFromGCS).mockResolvedValue({
      url: checkpointUrl,
      html: checkpointHtml,
      statusCode: 200,
      contentType: "text/html",
    } as any);
    await expect(scrapeURLWithIndex(meta())).rejects.toBeInstanceOf(
      IndexMissError,
    );
    expect(deleteCachedIndexEntry).toHaveBeenCalledWith(
      expect.any(String),
      "row-1",
      expect.anything(),
    );
  });

  it("reports a miss for a checkpoint page served from the entry cache", async () => {
    vi.mocked(getCachedIndexEntries).mockResolvedValue({
      status: "hit",
      entries: [
        {
          id: "row-cached",
          created_at: new Date().toISOString(),
          status: 200,
          has_screenshot: false,
          has_screenshot_fullscreen: false,
          wait_time_ms: null,
        },
      ],
    });
    vi.mocked(getIndexFromGCS).mockResolvedValue({
      url: checkpointUrl,
      html: checkpointHtml,
      statusCode: 200,
      contentType: "text/html",
    } as any);
    await expect(scrapeURLWithIndex(meta())).rejects.toBeInstanceOf(
      IndexMissError,
    );
    expect(indexGetRecent5).not.toHaveBeenCalled();
    expect(deleteCachedIndexEntry).toHaveBeenCalledWith(
      expect.any(String),
      "row-cached",
      expect.anything(),
    );
  });

  it("serves a cached product page", async () => {
    vi.mocked(getIndexFromGCS).mockResolvedValue({
      url: productUrl,
      html: "<p>product</p>",
      statusCode: 200,
      contentType: "text/html",
    } as any);
    const served = await scrapeURLWithIndex(meta());
    expect(served.html).toBe("<p>product</p>");
    expect(deleteCachedIndexEntry).not.toHaveBeenCalled();
  });
});
