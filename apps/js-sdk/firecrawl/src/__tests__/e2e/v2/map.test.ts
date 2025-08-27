/**
 * E2E tests for v2 map (translated from Python tests)
 */
import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-map" });
  client = new Firecrawl({ apiKey, apiUrl: API_URL });
});

describe("v2.map e2e", () => {

  test("minimal request", async () => {
    if (!client) throw new Error();
    const resp = await client.map("https://docs.firecrawl.dev");

    expect(resp).toBeTruthy();
    expect(Array.isArray(resp.links)).toBe(true);

    if (resp.links.length > 0) {
      const first: any = resp.links[0];
      expect(typeof first.url).toBe("string");
      expect(first.url.startsWith("http")).toBe(true);
    }
  }, 90_000);

  test.each(["only", "skip", "include"]) ("with options sitemap=%s", async (sitemap) => {
    if (!client) throw new Error();
    const resp = await client.map("https://docs.firecrawl.dev", {
      search: "docs",
      includeSubdomains: true,
      limit: 10,
      sitemap: sitemap as any,
      timeout: 15_000,
    });

    expect(resp).toBeTruthy();
    expect(Array.isArray(resp.links)).toBe(true);
    expect(resp.links.length).toBeLessThanOrEqual(10);

    for (const link of resp.links as any[]) {
      expect(typeof link.url).toBe("string");
      expect(link.url.startsWith("http")).toBe(true);
    }
  }, 120_000);
});

