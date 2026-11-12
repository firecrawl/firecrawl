import { vi } from "vitest";

vi.mock("../config", () => ({ config: { HANGAR_URL: "http://hangar.test" } }));

import {
  type BrowserOptions,
  browserOptionsFromScrape,
  hangarBrowserOptions,
  isBrowserOptions,
} from "./browser-options";
import { createHangarBrowser } from "./hangar";

async function hangarCreateBody(
  options: BrowserOptions,
  zeroDataRetention = false,
  usOnly = false,
) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({
      id: "br_1",
      status: "running",
      cdp_url: "wss://hangar.test/cdp",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await createHangarBrowser("key", "team", {
    ...options,
    ttl: 600,
    activityTtl: 300,
    streamWebView: true,
    recordSession: false,
    zeroDataRetention,
    usOnly,
  });
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("hangarBrowserOptions", () => {
  it("maps blockAds to Hangar's uBlock extension", () => {
    expect(hangarBrowserOptions({ blockAds: true }, false)).toEqual({
      extensions: ["ublock"],
    });
    expect(hangarBrowserOptions({ blockAds: false }, false)).toEqual({
      extensions: [],
    });
  });
});

describe("Hangar create body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fromScrape = (
    options: Parameters<typeof browserOptionsFromScrape>[0],
  ) => hangarCreateBody(browserOptionsFromScrape(options));

  it("selects a proxy in the scrape's location country", async () => {
    const body = await fromScrape({
      location: { country: "gb" },
      proxy: "auto",
    });
    expect(body.proxy).toEqual({ country: "gb", type: "basic" });
  });

  it("lowercases the scrape's country", async () => {
    const body = await fromScrape({ location: { country: "GB" } });
    expect(body.proxy).toEqual({ country: "gb", type: "basic" });
  });

  it("sends no proxy for a scrape without a location", async () => {
    const body = await fromScrape({ proxy: "auto" });
    expect(body).not.toHaveProperty("proxy");
  });

  it.each(["us-generic", "us-whitelist"])(
    "sends no proxy for a scrape located in %s",
    async country => {
      const body = await fromScrape({ location: { country } });
      expect(body).not.toHaveProperty("proxy");
    },
  );

  it.each(["stealth", "enhanced"] as const)(
    "uses the mobile pool for a %s scrape",
    async proxy => {
      expect(
        (await fromScrape({ location: { country: "de" }, proxy })).proxy,
      ).toEqual({ country: "de", type: "mobile" });
      expect((await fromScrape({ proxy })).proxy).toEqual({ type: "mobile" });
    },
  );

  it("selects a basic proxy in a /v2/browser session's country", async () => {
    const body = await hangarCreateBody({
      blockAds: true,
      location: { country: "jp" },
    });
    expect(body.proxy).toEqual({ country: "jp", type: "basic" });
  });

  it("sends no proxy for a /v2/browser session without a location", async () => {
    const body = await hangarCreateBody({ blockAds: true });
    expect(body).not.toHaveProperty("proxy");
  });
});

describe("Hangar create body under zero data retention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restricts a /v2/browser session to ZDR exits", async () => {
    const body = await hangarCreateBody({ blockAds: true }, true);
    expect(body.proxy).toEqual({
      type: "basic",
      zero_data_retention: true,
    });
  });

  it("keeps the scrape's country and pool within ZDR exits", async () => {
    const located = await hangarCreateBody(
      browserOptionsFromScrape({ location: { country: "gb" }, proxy: "auto" }),
      true,
    );
    expect(located.proxy).toEqual({
      country: "gb",
      type: "basic",
      zero_data_retention: true,
    });
    const stealth = await hangarCreateBody(
      browserOptionsFromScrape({ proxy: "stealth" }),
      true,
    );
    expect(stealth.proxy).toEqual({
      type: "mobile",
      zero_data_retention: true,
    });
  });
});

describe("Hangar create body for US-only teams", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always asks for a US exit", async () => {
    expect(
      (await hangarCreateBody({ blockAds: true }, false, true)).proxy,
    ).toEqual({
      country: "us",
      type: "basic",
    });
    expect(
      (
        await hangarCreateBody(
          browserOptionsFromScrape({ proxy: "stealth" }),
          false,
          true,
        )
      ).proxy,
    ).toEqual({ country: "us", type: "mobile" });
  });

  it("keeps ZDR exits within the US", async () => {
    const body = await hangarCreateBody({ blockAds: true }, true, true);
    expect(body.proxy).toEqual({
      country: "us",
      type: "basic",
      zero_data_retention: true,
    });
  });
});

describe("isBrowserOptions", () => {
  it("accepts options persisted before location and proxy were stored", () => {
    expect(isBrowserOptions({ blockAds: true })).toBe(true);
    expect(
      isBrowserOptions({
        blockAds: false,
        profile: { name: "default", saveChanges: true },
      }),
    ).toBe(true);
  });

  it("accepts options built from a located scrape", () => {
    expect(
      isBrowserOptions(
        browserOptionsFromScrape({
          location: { country: "gb" },
          proxy: "stealth",
        }),
      ),
    ).toBe(true);
  });

  it("rejects malformed location or proxy", () => {
    expect(isBrowserOptions({ blockAds: true, location: "gb" })).toBe(false);
    expect(isBrowserOptions({ blockAds: true, location: {} })).toBe(false);
    expect(isBrowserOptions({ blockAds: true, proxy: "auto" })).toBe(false);
  });
});
