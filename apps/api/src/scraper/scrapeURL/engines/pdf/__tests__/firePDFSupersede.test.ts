import crypto from "crypto";
import { robustFetch } from "../../../lib/fetch";
import {
  checkFirePdfSupersedes,
  lookupCachedResult,
} from "../fire-pdf/cache-service";
import { config } from "../../../../../config";

vi.mock("../../../lib/fetch", () => ({ robustFetch: vi.fn() }));
vi.mock("../fire-pdf/refresh-budget", () => ({
  recordRefreshDecision: vi.fn(),
}));

const fetchMock = vi.mocked(robustFetch);

function meta() {
  return {
    id: "supersede-test",
    logger: { info: vi.fn(), warn: vi.fn() },
    internalOptions: { zeroDataRetention: false, teamId: "team-1" },
    mock: null,
    firePdfCacheKey: {},
    abort: {
      asSignal: () => new AbortController().signal,
      throwIfAborted: vi.fn(),
    },
  } as any;
}

const answerWith = (fixture: unknown) =>
  fetchMock.mockImplementationOnce(async ({ schema }: any) =>
    schema.parse(fixture),
  );

const rawKey = `raw-${"a".repeat(64)}`;
const indexedAt = new Date("2026-10-01T00:00:00Z");

describe("checkFirePdfSupersedes", () => {
  beforeEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache";
    fetchMock.mockReset();
  });

  afterEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = undefined;
  });

  it("asks by key alone, without bytes", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    await checkFirePdfSupersedes(meta(), rawKey, indexedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0][0];
    expect(call.url).toBe("http://cache/cache/lookup");
    expect(call.body).toEqual({
      keys: [rawKey],
      options: {},
      team_id: "team-1",
      kind: "scrape",
      source_kind: "pdf",
      scrape_id: "supersede-test",
    });
    expect(call.tryCount).toBe(1);
  });

  it("bounds the check at one second", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answerWith({ outcome: "miss", reason: "not_found" });
    await checkFirePdfSupersedes(meta(), rawKey, indexedAt);
    expect(timeout).toHaveBeenCalledWith(1_000);
    timeout.mockRestore();
  });

  it("is superseded by a fresh entry written well after the index row", async () => {
    answerWith({ outcome: "hit", cached_at: "2026-10-05T00:00:00Z" });
    expect(await checkFirePdfSupersedes(meta(), rawKey, indexedAt)).toBe(
      "superseded",
    );
  });

  it("treats an entry written with the index row as the same parse", async () => {
    answerWith({ outcome: "hit", cached_at: "2026-10-01T00:05:00Z" });
    expect(await checkFirePdfSupersedes(meta(), rawKey, indexedAt)).toBe(
      "current",
    );
  });

  it("treats an older entry as current", async () => {
    answerWith({ outcome: "hit", cached_at: "2026-09-01T00:00:00Z" });
    expect(await checkFirePdfSupersedes(meta(), rawKey, indexedAt)).toBe(
      "current",
    );
  });

  it.each([
    ["a miss", { outcome: "miss", reason: "campaign" }],
    [
      "a stale entry",
      { outcome: "stale", cached_at: "2026-10-05T00:00:00Z", campaign: "c" },
    ],
    ["a hit without cached_at", { outcome: "hit" }],
  ])("keeps the index copy on %s", async (_name, fixture) => {
    answerWith(fixture);
    expect(await checkFirePdfSupersedes(meta(), rawKey, indexedAt)).toBe(
      "current",
    );
  });

  it("reports a failed check as error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await checkFirePdfSupersedes(meta(), rawKey, indexedAt)).toBe(
      "error",
    );
  });
});

describe("lookupCachedResult records the content key", () => {
  beforeEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache";
    fetchMock.mockReset();
  });

  afterEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = undefined;
  });

  const args = {
    mode: undefined,
    pagesProcessed: undefined,
    includePageMarkdown: false,
    includeBlocks: false,
    pageMarkers: false,
    refresh: false,
    sourceKind: "pdf" as const,
    ownVariant: "base",
  };

  it("stores the raw key of inline bytes on meta", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    const base64 = Buffer.from("%PDF-1.7 key test").toString("base64");
    const m = meta();
    await lookupCachedResult(m, base64, args);
    const expected = `raw-${crypto
      .createHash("sha256")
      .update(Buffer.from(base64, "base64"))
      .digest("hex")}`;
    expect(m.firePdfCacheKey.current).toBe(expected);
  });

  it("stores a by-reference raw key on meta", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    const m = meta();
    await lookupCachedResult(m, { key: rawKey }, args);
    expect(m.firePdfCacheKey.current).toBe(rawKey);
  });

  it("does not record a key for a raster image", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    const m = meta();
    await lookupCachedResult(m, Buffer.from("png").toString("base64"), {
      ...args,
      sourceKind: "image",
    });
    expect(m.firePdfCacheKey.current).toBeUndefined();
  });

  it("records the key on the holder shared by engine copies of meta", async () => {
    answerWith({ outcome: "miss", reason: "not_found" });
    const outer = meta();
    const engineCopy = { ...outer };
    await lookupCachedResult(engineCopy, { key: rawKey }, args);
    expect(outer.firePdfCacheKey.current).toBe(rawKey);
  });
});
