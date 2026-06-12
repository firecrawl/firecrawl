import IORedis from "ioredis";
import {
  deriveIndexVariantKey,
  filterIndexEntries,
  getCachedIndexEntries,
  getCachedMaxAge,
  upsertCachedIndexEntries,
  type IndexCacheEntry,
} from "../../services/index-cache";
import { hashURL } from "../../services";

const urlHash = hashURL("https://example.com/page");

const baseKeyParams = {
  urlHash,
  isMobile: false,
  blockAds: true,
  isStealth: false,
  locationCountry: null,
  locationLanguages: null,
};

function entry(overrides: Partial<IndexCacheEntry> = {}): IndexCacheEntry {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    status: 200,
    has_screenshot: false,
    has_screenshot_fullscreen: false,
    wait_time_ms: null,
    ...overrides,
  };
}

describe("deriveIndexVariantKey", () => {
  it("is stable for identical params", () => {
    expect(deriveIndexVariantKey(baseKeyParams)).toBe(
      deriveIndexVariantKey({ ...baseKeyParams }),
    );
  });

  it("changes when any exact-match dimension changes", () => {
    const base = deriveIndexVariantKey(baseKeyParams);
    expect(deriveIndexVariantKey({ ...baseKeyParams, isMobile: true })).not.toBe(
      base,
    );
    expect(deriveIndexVariantKey({ ...baseKeyParams, blockAds: false })).not.toBe(
      base,
    );
    expect(
      deriveIndexVariantKey({ ...baseKeyParams, isStealth: true }),
    ).not.toBe(base);
    expect(
      deriveIndexVariantKey({ ...baseKeyParams, locationCountry: "DE" }),
    ).not.toBe(base);
    expect(
      deriveIndexVariantKey({
        ...baseKeyParams,
        urlHash: hashURL("https://example.com/other"),
      }),
    ).not.toBe(base);
  });

  it("treats languages as a set (order and duplicates ignored), matching the SQL @>/<@ comparison", () => {
    const a = deriveIndexVariantKey({
      ...baseKeyParams,
      locationLanguages: ["en", "de"],
    });
    const b = deriveIndexVariantKey({
      ...baseKeyParams,
      locationLanguages: ["de", "en", "de"],
    });
    expect(a).toBe(b);
  });

  it("keeps empty language array distinct from null, matching the SQL IS NULL check", () => {
    const empty = deriveIndexVariantKey({
      ...baseKeyParams,
      locationLanguages: [],
    });
    const nul = deriveIndexVariantKey({
      ...baseKeyParams,
      locationLanguages: null,
    });
    expect(empty).not.toBe(nul);
  });
});

describe("filterIndexEntries", () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;

  it("applies the maxAge window", () => {
    const fresh = entry({ created_at: new Date(now - hour).toISOString() });
    const stale = entry({ created_at: new Date(now - 5 * hour).toISOString() });
    const result = filterIndexEntries([fresh, stale], {
      maxAgeMs: 2 * hour,
      minAgeMs: null,
      needsScreenshot: false,
      needsScreenshotFullscreen: false,
      waitTimeMs: 0,
      now,
    });
    expect(result.map(x => x.id)).toEqual([fresh.id]);
  });

  it("applies the minAge window", () => {
    const tooFresh = entry({ created_at: new Date(now - hour).toISOString() });
    const oldEnough = entry({
      created_at: new Date(now - 5 * hour).toISOString(),
    });
    const result = filterIndexEntries([tooFresh, oldEnough], {
      maxAgeMs: 24 * hour,
      minAgeMs: 2 * hour,
      needsScreenshot: false,
      needsScreenshotFullscreen: false,
      waitTimeMs: 0,
      now,
    });
    expect(result.map(x => x.id)).toEqual([oldEnough.id]);
  });

  it("matches screenshot capability like the SQL (request-false matches anything, request-true requires it)", () => {
    const withShot = entry({ has_screenshot: true });
    const withoutShot = entry({ has_screenshot: false });
    const opts = {
      maxAgeMs: hour,
      minAgeMs: null,
      needsScreenshotFullscreen: false,
      waitTimeMs: 0,
      now,
    };
    expect(
      filterIndexEntries([withShot, withoutShot], {
        ...opts,
        needsScreenshot: false,
      }),
    ).toHaveLength(2);
    expect(
      filterIndexEntries([withShot, withoutShot], {
        ...opts,
        needsScreenshot: true,
      }).map(x => x.id),
    ).toEqual([withShot.id]);
  });

  it("compares waitFor like the SQL (COALESCE(entry, 0) >= requested)", () => {
    const noWait = entry({ wait_time_ms: null });
    const shortWait = entry({ wait_time_ms: 500 });
    const longWait = entry({ wait_time_ms: 5000 });
    const opts = {
      maxAgeMs: hour,
      minAgeMs: null,
      needsScreenshot: false,
      needsScreenshotFullscreen: false,
      now,
    };
    expect(
      filterIndexEntries([noWait, shortWait, longWait], {
        ...opts,
        waitTimeMs: 0,
      }),
    ).toHaveLength(3);
    expect(
      filterIndexEntries([noWait, shortWait, longWait], {
        ...opts,
        waitTimeMs: 1000,
      }).map(x => x.id),
    ).toEqual([longWait.id]);
  });

  it("sorts newest-first and caps at 5 like the SQL LIMIT", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry({ created_at: new Date(now - i * 1000).toISOString() }),
    );
    const shuffled = [...entries].reverse();
    const result = filterIndexEntries(shuffled, {
      maxAgeMs: hour,
      minAgeMs: null,
      needsScreenshot: false,
      needsScreenshotFullscreen: false,
      waitTimeMs: 0,
      now,
    });
    expect(result).toHaveLength(5);
    expect(result.map(x => x.id)).toEqual(entries.slice(0, 5).map(x => x.id));
  });
});

describe("index cache fail-open", () => {
  // Points at a port nothing listens on: every operation must resolve (not
  // throw, not hang) so the read path can fall back to Postgres.
  let deadClient: IORedis;

  beforeAll(() => {
    deadClient = new IORedis("redis://127.0.0.1:1", {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    deadClient.on("error", () => {});
    deadClient.connect().catch(() => {});
  });

  afterAll(() => {
    deadClient.disconnect();
  });

  it("getCachedIndexEntries resolves to error status", async () => {
    const result = await getCachedIndexEntries(
      "idxc:test",
      undefined,
      deadClient,
    );
    expect(result.status).toBe("error");
  }, 5000);

  it("upsertCachedIndexEntries resolves without throwing", async () => {
    await expect(
      upsertCachedIndexEntries("idxc:test", [entry()], undefined, deadClient),
    ).resolves.toBeUndefined();
  }, 5000);

  it("getCachedMaxAge resolves to null", async () => {
    await expect(
      getCachedMaxAge(urlHash, undefined, deadClient),
    ).resolves.toBeNull();
  }, 5000);
});
