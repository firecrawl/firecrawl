import request from "supertest";
import {
  describeIf,
  idmux,
  Identity,
  TEST_API_URL,
  TEST_PRODUCTION,
} from "../lib";
import { scrapeRaw } from "./lib";

// =========================================
// v0 + forced threat protection
//
// The deprecated v0 endpoints never resolve a threat protection policy, so
// teams whose flag is "forced" must be rejected on the content-fetching v0
// endpoints (scrape, crawl, search) with 403. The rejection happens right
// after auth — before any credit check or scraping — so no provider or
// scrape target is needed. crawl-status/crawl-cancel intentionally stay
// open so existing jobs can drain.
// =========================================

async function crawlRaw(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v0/crawl")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

async function searchRaw(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v0/search")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

// Requires idmux-provisioned team flags, which only exist in the production
// test configuration.
describeIf(TEST_PRODUCTION)("V0 threat protection (forced flag)", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v0-threat-protection/forced",
      flags: {
        threatProtection: "forced",
      },
    });
  }, 10000);

  it.concurrent("rejects v0 scrape with 403", async () => {
    const res = await scrapeRaw({ url: "https://firecrawl.dev" }, identity);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain("Threat protection");
    expect(res.body.error).toContain("v0");
  });

  it.concurrent("rejects v0 crawl with 403", async () => {
    const res = await crawlRaw({ url: "https://firecrawl.dev" }, identity);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain("Threat protection");
    expect(res.body.error).toContain("v0");
  });

  it.concurrent("rejects v0 search with 403", async () => {
    const res = await searchRaw({ query: "firecrawl" }, identity);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain("Threat protection");
    expect(res.body.error).toContain("v0");
  });
});
