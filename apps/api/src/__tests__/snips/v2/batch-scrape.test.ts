import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  TEST_API_URL,
} from "../lib";
import { z } from "zod";
import type { Identity } from "./lib";
import { batchScrape, scrapeTimeout, idmux } from "./lib";
import request from "supertest";

const batchStartResponseSchema = z.object({
  id: z.string(),
});

let identity: Identity;
let lowConcurrencyIdentity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "batch-scrape",
    concurrency: 100,
    credits: 1_000_000,
  });
  lowConcurrencyIdentity = await idmux({
    name: "batch-scrape-cancel",
    concurrency: 2,
    credits: 1_000_000,
  });
}, 10_000);

describe("Batch scrape tests", () => {
  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "works",
    async () => {
      const response = await batchScrape(
        {
          urls: [TEST_SUITE_WEBSITE],
        },
        identity,
      );

      expect(response.data[0]).toHaveProperty("markdown");
      expect(response.data[0].markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sourceURL stays unnormalized",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}/?pagewanted=all&et_blog`;
      const response = await batchScrape(
        {
          urls: [url],
        },
        identity,
      );

      expect(response.data[0].metadata.sourceURL).toBe(url);
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "cancel flips batch status to cancelled immediately",
    async () => {
      const apiKey = lowConcurrencyIdentity.apiKey;
      const urls = Array.from(
        { length: 20 },
        (_, i) => `${TEST_SUITE_WEBSITE}?cancelTest=${i}`,
      );

      const start = await request(TEST_API_URL)
        .post("/v2/batch/scrape")
        .set("Authorization", `Bearer ${apiKey}`)
        .set("Content-Type", "application/json")
        .send({ urls });
      expect(start.statusCode).toBe(200);
      expect(start.body.success).toBe(true);
      const parsedStart = batchStartResponseSchema.safeParse(start.body);
      if (!parsedStart.success) {
        throw new Error("Expected batch scrape start response with id");
      }
      const id = parsedStart.data.id;

      const cancel = await request(TEST_API_URL)
        .delete(`/v2/batch/scrape/${encodeURIComponent(id)}`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send();
      expect(cancel.statusCode).toBe(200);
      expect(cancel.body.status).toBe("cancelled");

      const statusAfter = await request(TEST_API_URL)
        .get(`/v2/batch/scrape/${encodeURIComponent(id)}`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send();
      expect(statusAfter.statusCode).toBe(200);
      expect(statusAfter.body.status).toBe("cancelled");
    },
    scrapeTimeout,
  );

  it.concurrent("cancel rejects unknown batch id with 404", async () => {
    const unknownId = "00000000-0000-7000-8000-000000000000";
    const res = await request(TEST_API_URL)
      .delete(`/v2/batch/scrape/${unknownId}`)
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .send();
    expect(res.statusCode).toBe(404);
  });

  describeIf(TEST_PRODUCTION)("JSON format", () => {
    it.concurrent("works", async () => {
      const response = await batchScrape(
        {
          urls: [TEST_SUITE_WEBSITE],
          formats: [
            {
              type: "json",
              prompt:
                "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source.",
              schema: {
                type: "object",
                properties: {
                  company_mission: {
                    type: "string",
                  },
                  supports_sso: {
                    type: "boolean",
                  },
                  is_open_source: {
                    type: "boolean",
                  },
                },
                required: ["company_mission", "supports_sso", "is_open_source"],
              },
            },
          ],
        },
        identity,
      );

      expect(response.data[0]).toHaveProperty("json");
      const json = response.data[0].json;
      expect(json).toEqual(
        expect.objectContaining({
          company_mission: expect.any(String),
          supports_sso: false,
          is_open_source: true,
        }),
      );
    }, 180_000);
  });
});
