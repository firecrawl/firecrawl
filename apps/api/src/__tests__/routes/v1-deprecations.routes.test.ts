import express from "express";
import request from "supertest";
import { deprecationMiddleware } from "../../lib/deprecations";

const V1_DEPRECATED_AT = "@1793923200";
const GUIDE = "https://docs.firecrawl.dev/migrate-to-v2";

const V1 = {
  v1_scrape: "/v2/scrape",
  v1_scrape_status: "/v2/scrape/:jobId",
  v1_crawl: "/v2/crawl",
  v1_crawl_status: "/v2/crawl/:jobId",
  v1_crawl_cancel: "/v2/crawl/:jobId",
  v1_crawl_errors: "/v2/crawl/:jobId/errors",
  v1_crawl_active: "/v2/crawl/active",
  v1_crawl_ongoing: "/v2/crawl/active",
  v1_batch_scrape: "/v2/batch/scrape",
  v1_batch_scrape_status: "/v2/batch/scrape/:jobId",
  v1_batch_scrape_cancel: "/v2/batch/scrape/:jobId",
  v1_batch_scrape_errors: "/v2/batch/scrape/:jobId/errors",
  v1_search: "/v2/search",
  v1_map: "/v2/map",
  v1_concurrency_check: "/v2/concurrency-check",
  v1_team_credit_usage: "/v2/team/credit-usage",
  v1_team_credit_usage_historical: "/v2/team/credit-usage/historical",
  v1_team_token_usage: "/v2/team/token-usage",
  v1_team_token_usage_historical: "/v2/team/token-usage/historical",
  v1_team_queue_status: "/v2/team/queue-status",
} as const;

type Key = keyof typeof V1;

function appFor(key: Key) {
  const app = express();
  app.get("/probe", deprecationMiddleware(key), (_req, res) => {
    res.status(200).json({ success: true, data: { markdown: "# hi" } });
  });
  return app;
}

describe("v1 route deprecations", () => {
  for (const key of Object.keys(V1) as Key[]) {
    it(`${key} points at ${V1[key]} and the migration guide, with no sunset`, async () => {
      const res = await request(appFor(key)).get("/probe");

      expect(res.headers["deprecation"]).toBe(V1_DEPRECATED_AT);
      expect(res.headers["sunset"]).toBeUndefined();
      expect(res.headers["link"]).toBe(
        `<${GUIDE}>; rel="deprecation", <${V1[key]}>; rel="successor-version"`,
      );
      expect(res.headers["warning"]).toMatch(
        /^299 - "(?:DELETE )?\/v1\/.* is deprecated\./,
      );
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ markdown: "# hi" });
      expect(res.body.replacement).toBe(V1[key]);
      expect(res.body.warnings).toHaveLength(1);
      expect(res.body.warnings[0]).toContain(GUIDE);
    });
  }
});
