import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { describeIf, TEST_PRODUCTION } from "../lib";
import { scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";
import { redisEvictConnection } from "../../../services/redis";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-dns-negative-cache",
    concurrency: 10,
    credits: 100,
  });
}, 10000);

afterAll(async () => {
  redisEvictConnection.disconnect();
});

describe("negative DNS cache", () => {
  describeIf(TEST_PRODUCTION)("population", () => {
    it(
      "records a failed hostname and keeps failing it with the same error",
      async () => {
        const hostname = `${crypto.randomUUID()}-dead.invalid`;

        const first = await scrapeRaw(
          { url: `https://${hostname}/` },
          identity,
        );
        expect(first.statusCode).toBe(200);
        expect(first.body.success).toBe(false);
        expect(first.body.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");

        expect(await redisEvictConnection.exists(`dnsneg:${hostname}`)).toBe(1);

        const second = await scrapeRaw(
          { url: `https://${hostname}/` },
          identity,
        );
        expect(second.statusCode).toBe(200);
        expect(second.body.success).toBe(false);
        expect(second.body.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
      },
      scrapeTimeout * 2,
    );
  });

  it(
    "fails fast without engines when the hostname has a marker",
    async () => {
      // iana.org resolves fine — a DNS error can only come from the cache.
      const hostname = "iana.org";
      await redisEvictConnection.set(`dnsneg:${hostname}`, "1", "PX", 60000);
      try {
        const response = await scrapeRaw(
          { url: `https://${hostname}/` },
          identity,
        );
        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
      } finally {
        await redisEvictConnection.del(`dnsneg:${hostname}`);
      }
    },
    scrapeTimeout,
  );
});
