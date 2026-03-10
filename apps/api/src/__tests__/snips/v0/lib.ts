import request from "supertest";
import {
  TEST_API_URL,
  scrapeTimeout,
  indexCooldown,
  Identity,
  idmux,
} from "../lib";

// Re-export shared utilities for backwards compatibility
export { scrapeTimeout, indexCooldown, Identity, idmux };

export interface V0ScrapeRequestInput {
  url: string;
  pageOptions?: any;
  extractorOptions?: any;
  crawlerOptions?: any;
  timeout?: number;
  origin?: string;
  integration?: string;
}

export async function scrapeRaw(
  body: V0ScrapeRequestInput,
  identity: Identity,
) {
  return await request(TEST_API_URL)
    .post("/v0/scrape")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}
