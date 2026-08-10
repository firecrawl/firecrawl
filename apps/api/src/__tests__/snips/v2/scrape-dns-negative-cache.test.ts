import { it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { config } from "../../../config";
import { describeIf, TEST_PRODUCTION } from "../lib";
import { scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";
import { redisEvictConnection } from "../../../services/redis";
import {
  cacheDnsFailure,
  isDnsFailureCached,
  dnsNegativeCacheRedis,
} from "../../../lib/dns-negative-cache";

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
  dnsNegativeCacheRedis?.disconnect();
});

describeIf(config.DNS_NEGATIVE_CACHE_TTL_MS > 0)("negative DNS cache", () => {
  // Needs a real DNS failure classified as SCRAPE_DNS_RESOLUTION_ERROR,
  // which self-hosted engines don't produce. Asserts behavior only — the
  // test process must never touch the production evict Redis.
  describeIf(TEST_PRODUCTION)("population", () => {
    it(
      "keeps failing a dead hostname with the same error",
      async () => {
        const hostname = `${crypto.randomUUID()}-dead.invalid`;

        // Two real DNS failures reach the block threshold; the third scrape
        // is served by the fail-fast path and must be indistinguishable.
        for (let i = 0; i < 3; i++) {
          const response = await scrapeRaw(
            { url: `https://${hostname}/` },
            identity,
          );
          expect(response.statusCode).toBe(200);
          expect(response.body.success).toBe(false);
          expect(response.body.code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
        }
      },
      scrapeTimeout * 3,
    );
  });

  // These write markers directly, so they only run against the local
  // harness Redis — never against production.
  describeIf(!TEST_PRODUCTION)("fail-fast", () => {
    it("blocks only after two recorded failures", async () => {
      const hostname = `${crypto.randomUUID()}-dead.invalid`;

      expect(await isDnsFailureCached(hostname)).toBe(false);
      await cacheDnsFailure(hostname);
      expect(await isDnsFailureCached(hostname)).toBe(false);
      await cacheDnsFailure(hostname);
      expect(await isDnsFailureCached(hostname)).toBe(true);
    });

    it(
      "fails fast without engines when the hostname is at the block threshold",
      async () => {
        // iana.org resolves fine — a DNS error can only come from the cache.
        const hostname = "iana.org";
        await redisEvictConnection.set(`dnsneg:${hostname}`, "2", "PX", 60000);
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

    it(
      "does not block a hostname after a single failure",
      async () => {
        const hostname = "example.com";
        await redisEvictConnection.set(`dnsneg:${hostname}`, "1", "PX", 60000);
        try {
          const response = await scrapeRaw(
            { url: `https://${hostname}/` },
            identity,
          );
          expect(response.statusCode).toBe(200);
          expect(response.body.success).toBe(true);
        } finally {
          await redisEvictConnection.del(`dnsneg:${hostname}`);
        }
      },
      scrapeTimeout,
    );
  });
});
