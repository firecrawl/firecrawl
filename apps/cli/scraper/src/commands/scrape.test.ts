import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { buildRequest, resolveEngine } from "./scrape.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "http://localhost:3002",
    concurrency: 5,
    retries: { attempts: 3, initialDelayMs: 500 },
    cdp: { url: "http://localhost:9222" },
    profiles: {},
    domains: {},
    ...overrides,
  };
}

describe("resolveEngine", () => {
  it("defaults to api when nothing is set", () => {
    expect(resolveEngine("https://x.io", makeConfig(), "default", undefined)).toBe("api");
  });

  it("CLI override beats every other source", () => {
    const config = makeConfig({
      profiles: { default: { engine: "api" } },
      domains: { "x.io": { engine: "api" } },
    });
    expect(resolveEngine("https://x.io", config, "default", "cdp")).toBe("cdp");
  });

  it("domain override beats profile", () => {
    const config = makeConfig({
      profiles: { default: { engine: "api" } },
      domains: { "x.io": { engine: "cdp" } },
    });
    expect(resolveEngine("https://x.io", config, "default", undefined)).toBe("cdp");
  });

  it("profile setting wins when no domain match and no CLI flag", () => {
    const config = makeConfig({
      profiles: { paywalled: { engine: "cdp" } },
    });
    expect(resolveEngine("https://other.io", config, "paywalled", undefined)).toBe("cdp");
  });

  it("ignores domain entries that don't match the URL host", () => {
    const config = makeConfig({
      domains: { "nytimes.com": { engine: "cdp" } },
    });
    expect(resolveEngine("https://example.com/x", config, "default", undefined)).toBe("api");
  });
});

describe("buildRequest", () => {
  it("uses the passed apiFormats when no profile/domain provides them", () => {
    const req = buildRequest("https://x.io", makeConfig(), "default", ["markdown"]);
    expect(req.formats).toEqual(["markdown"]);
    expect(req.url).toBe("https://x.io");
  });

  it("merges default profile + named profile + domain override", () => {
    const config = makeConfig({
      profiles: {
        default: { onlyMainContent: true, formats: ["markdown"] },
        docs: { excludeTags: ["nav"] },
      },
      domains: { "docs.io": { waitFor: 3000 } },
    });
    const req = buildRequest("https://docs.io/p", config, "docs", ["markdown"]);
    expect(req.onlyMainContent).toBe(true);
    expect(req.excludeTags).toEqual(["nav"]);
    expect(req.waitFor).toBe(3000);
    expect(req.formats).toEqual(["markdown"]);
  });

  it("deep-merges headers from profile + domain override", () => {
    const config = makeConfig({
      profiles: {
        default: { headers: { "User-Agent": "ua" } },
      },
      domains: {
        "x.io": { headers: { Cookie: "c" } },
      },
    });
    const req = buildRequest("https://x.io", config, "default", ["markdown"]);
    expect(req.headers).toEqual({ "User-Agent": "ua", Cookie: "c" });
  });
});
