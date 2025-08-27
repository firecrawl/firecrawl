/**
 * E2E tests for v2 search (translated from Python tests)
 */
import Firecrawl from "../../../index";
import type { Document, SearchResult } from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-search" });
  client = new Firecrawl({ apiKey, apiUrl: API_URL });
});

function collectTexts(entries: any[] | undefined): string[] {
  const texts: string[] = [];
  for (const r of entries || []) {
    const title = (r && typeof r === 'object') ? (r.title as unknown as string | undefined) : undefined;
    const desc = (r && typeof r === 'object') ? (r.description as unknown as string | undefined) : undefined;
    if (title) texts.push(String(title).toLowerCase());
    if (desc) texts.push(String(desc).toLowerCase());
  }
  return texts;
}

function isDocument(entry: Document | SearchResult | undefined | null): entry is Document {
  if (!entry) return false;
  const d = entry as Document;
  return (
    typeof d.markdown === 'string' ||
    typeof d.rawHtml === 'string' ||
    typeof d.html === 'string' ||
    typeof d.links === 'object' ||
    typeof d.screenshot === 'string' ||
    typeof d.changeTracking === 'object' ||
    typeof d.summary === 'string' ||
    typeof d.json === 'object'
  );
}

describe("v2.search e2e", () => {

  test("minimal request", async () => {
    if (!client) throw new Error();
    const results = await client.search("What is the capital of France?");
    expect(results).toBeTruthy();
    expect(results).toHaveProperty("web");
    expect(results).not.toHaveProperty("news");
    expect(results).not.toHaveProperty("images");

    expect(results.web).toBeTruthy();
    expect((results.web || []).length).toBeGreaterThan(0);

    for (const result of results.web || []) {
      if (isDocument(result)) {
        // documents appear if scraping happens
        continue;
      }
      expect(typeof result.url).toBe("string");
      expect(result.url.startsWith("http")).toBe(true);
      expect(typeof result.title === "string" || result.title == null).toBe(true);
      expect(typeof result.description === "string" || result.description == null).toBe(true);
    }

    const allText = collectTexts(results.web).join(" ");
    expect(allText.includes("paris")).toBe(true);

    expect(results.news == null).toBe(true);
    expect(results.images == null).toBe(true);
  }, 90_000);

  test("with sources web+news and limit", async () => {
    if (!client) throw new Error();
    const results = await client.search("firecrawl", { sources: ["web", "news"], limit: 3 });
    expect(results).toBeTruthy();
    expect(results.web).toBeTruthy();
    expect((results.web || []).length).toBeLessThanOrEqual(3);
    if (results.news != null) {
      expect((results.news || []).length).toBeLessThanOrEqual(3);
    }
    expect(results.images == null).toBe(true);

    const webTitles = (results.web || [])
      .filter((r): r is SearchResult => !isDocument(r))
      .map(r => (r.title || "").toString().toLowerCase());
    const webDescriptions = (results.web || [])
      .filter((r): r is SearchResult => !isDocument(r))
      .map(r => (r.description || "").toString().toLowerCase());
    const allWebText = (webTitles.concat(webDescriptions)).join(" ");
    expect(allWebText.includes("firecrawl")).toBe(true);
  }, 90_000);

  test("result structure", async () => {
    if (!client) throw new Error();
    const results = await client.search("test query", { limit: 1 });
    if (results.web && results.web.length > 0) {
      const result: any = results.web[0];
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(typeof result.url).toBe("string");
      expect(typeof result.title === "string" || result.title == null).toBe(true);
      expect(typeof result.description === "string" || result.description == null).toBe(true);
      expect(result.url.startsWith("http")).toBe(true);
    }
  }, 90_000);

  test("all parameters (comprehensive)", async () => {
    if (!client) throw new Error();
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        url: { type: "string" },
      },
      required: ["title", "description"],
    } as const;

    const results = await client.search("artificial intelligence", {
      sources: [ "web", "news", "images" ],
      limit: 3,
      tbs: "qdr:m",
      location: "US",
      ignoreInvalidURLs: true,
      timeout: 60_000,
      scrapeOptions: {
        formats: [
          "markdown",
          "html",
          { type: "json", prompt: "Extract the title and description from the page", schema },
        ],
        headers: { "User-Agent": "Firecrawl-Test/1.0" },
        includeTags: ["h1", "h2", "p"],
        excludeTags: ["nav", "footer"],
        onlyMainContent: true,
        waitFor: 2000,
        mobile: false,
        skipTlsVerification: false,
        removeBase64Images: true,
        blockAds: true,
        proxy: "basic",
        maxAge: 3_600_000,
        storeInCache: true,
        location: { country: "US", languages: ["en"] },
        actions: [{ type: "wait", milliseconds: 1000 }],
      },
    });

    expect(results).toBeTruthy();
    expect(results).toHaveProperty("web");
    expect(results).toHaveProperty("news");
    expect(results).toHaveProperty("images");

    expect(results.web).toBeTruthy();
    expect((results.web || []).length).toBeLessThanOrEqual(3);

    const nonDocEntries = (results.web || []).filter(r => !isDocument(r));
    if (nonDocEntries.length > 0) {
      const allWebText = collectTexts(nonDocEntries).join(" ");
      const aiTerms = ["artificial", "intelligence", "ai", "machine", "learning"];
      expect(aiTerms.some(t => allWebText.includes(t))).toBe(true);
    }

    for (const result of results.web || []) {
      if (isDocument(result)) {
        expect(Boolean(result.markdown) || Boolean(result.html)).toBe(true);
      } else {
        expect(typeof result.url).toBe("string");
        expect(result.url.startsWith("http")).toBe(true);
      }
    }

    if (results.news != null) {
      expect((results.news || []).length).toBeLessThanOrEqual(3);
      for (const result of results.news || []) {
        if (isDocument(result)) {
          expect(Boolean(result.markdown) || Boolean(result.html)).toBe(true);
        } else {
          expect(typeof result.url).toBe("string");
          expect(result.url.startsWith("http")).toBe(true);
        }
      }
    }

    expect(results.images).toBeTruthy();
    expect((results.images || []).length).toBeLessThanOrEqual(3);
    for (const result of results.images || []) {
      if (!isDocument(result)) {
        expect(typeof result.url).toBe("string");
        expect(result.url.startsWith("http")).toBe(true);
      }
    }
  }, 120_000);

  test("formats flexibility: list vs object", async () => {
    if (!client) throw new Error();
    const results1 = await client.search("python programming", {
      limit: 1,
      scrapeOptions: { formats: ["markdown"] },
    });
    const results2 = await client.search("python programming", {
      limit: 1,
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(results1).toBeTruthy();
    expect(results2).toBeTruthy();
    expect(results1.web).toBeTruthy();
    expect(results2.web).toBeTruthy();
  }, 90_000);

  test("with json format object", async () => {
    if (!client) throw new Error();
    const jsonSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
    const results = await client.search("site:docs.firecrawl.dev", {
      limit: 1,
      scrapeOptions: {
        formats: [{ type: "json", prompt: "Extract page title", schema: jsonSchema }],
      },
    });
    expect(results).toBeTruthy();
    expect(Array.isArray(results.web) || results.web == null).toBe(true);
  }, 90_000);

  test("with summary format, documents include summary when present", async () => {
    if (!client) throw new Error();
    const results = await client.search("site:firecrawl.dev", {
      limit: 1,
      scrapeOptions: { formats: ["summary"] },
    });
    const docs = (results.web || []).filter(r => isDocument(r)) as Document[];
    if (docs.length > 0) {
      expect(typeof docs[0].summary).toBe("string");
      expect((docs[0].summary || "").length).toBeGreaterThan(5);
    }
  }, 90_000);
});

