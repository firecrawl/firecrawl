import { vi } from "vitest";

vi.mock("../config", () => ({ config: { HANGAR_URL: "http://hangar.test" } }));

import {
  browserOptionsFromScrape,
  hangarBrowserOptions,
  isBrowserOptions,
} from "./browser-options";
import { createHangarBrowser } from "./hangar";

async function hangarCreateBody(
  scrapeOptions: Parameters<typeof browserOptionsFromScrape>[0],
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
    ...browserOptionsFromScrape(scrapeOptions),
    ttl: 600,
    activityTtl: 300,
    streamWebView: true,
    recordSession: false,
  });
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("hangarBrowserOptions", () => {
  it("maps blockAds to Hangar's uBlock extension", () => {
    expect(hangarBrowserOptions({ blockAds: true })).toEqual({
      extensions: ["ublock"],
    });
    expect(hangarBrowserOptions({ blockAds: false })).toEqual({
      extensions: [],
    });
  });
});

describe("Hangar create body for a scrape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects a proxy in the scrape's location country", async () => {
    const body = await hangarCreateBody({
      location: { country: "gb" },
      proxy: "auto",
    });
    expect(body.proxy).toEqual({ country: "gb", type: "basic" });
  });

  it("lowercases the country", async () => {
    const body = await hangarCreateBody({ location: { country: "GB" } });
    expect(body.proxy).toEqual({ country: "gb", type: "basic" });
  });

  it("sends no proxy without a location", async () => {
    const body = await hangarCreateBody({ proxy: "auto" });
    expect(body).not.toHaveProperty("proxy");
  });

  it.each(["us-generic", "us-whitelist"])(
    "sends no proxy for %s",
    async country => {
      const body = await hangarCreateBody({ location: { country } });
      expect(body).not.toHaveProperty("proxy");
    },
  );

  it.each(["stealth", "enhanced"] as const)(
    "uses the mobile pool for a %s scrape",
    async proxy => {
      expect(
        (await hangarCreateBody({ location: { country: "de" }, proxy })).proxy,
      ).toEqual({ country: "de", type: "mobile" });
      expect((await hangarCreateBody({ proxy })).proxy).toEqual({
        type: "mobile",
      });
    },
  );
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
