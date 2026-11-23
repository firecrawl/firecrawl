import express from "express";
import request from "supertest";
import { v1Router } from "../../routes/v1";

const GUIDE = "https://docs.firecrawl.dev/migrate-to-v2";
const V1_SUNSET = "Thu, 10 Dec 2026 15:00:00 GMT";

const REMOVED = [
  ["post", "/v1/scrape", "/v2/scrape"],
  ["get", "/v1/scrape/job-1", "/v2/scrape/:jobId"],
  ["post", "/v1/crawl", "/v2/crawl"],
  ["get", "/v1/crawl/job-1", "/v2/crawl/:jobId"],
  ["delete", "/v1/crawl/job-1", "/v2/crawl/:jobId"],
  ["get", "/v1/crawl/job-1/errors", "/v2/crawl/:jobId/errors"],
  ["get", "/v1/crawl/active", "/v2/crawl/active"],
  ["get", "/v1/crawl/ongoing", "/v2/crawl/active"],
  ["post", "/v1/batch/scrape", "/v2/batch/scrape"],
  ["get", "/v1/batch/scrape/job-1", "/v2/batch/scrape/:jobId"],
  ["delete", "/v1/batch/scrape/job-1", "/v2/batch/scrape/:jobId"],
  ["get", "/v1/batch/scrape/job-1/errors", "/v2/batch/scrape/:jobId/errors"],
  ["post", "/v1/search", "/v2/search"],
  ["post", "/v1/map", "/v2/map"],
  ["get", "/v1/concurrency-check", "/v2/concurrency-check"],
  ["get", "/v1/team/credit-usage", "/v2/team/credit-usage"],
  [
    "get",
    "/v1/team/credit-usage/historical",
    "/v2/team/credit-usage/historical",
  ],
  ["get", "/v1/team/token-usage", "/v2/team/token-usage"],
  ["get", "/v1/team/token-usage/historical", "/v2/team/token-usage/historical"],
  ["get", "/v1/team/queue-status", "/v2/team/queue-status"],
] as const;

const app = express();
app.use("/v1", v1Router);

describe("removed v1 routes", () => {
  it.each(REMOVED)(
    "%s %s answers 410 without auth and points at %s",
    async (method, path, replacement) => {
      const res = await request(app)[method](path);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({
        success: false,
        code: "ENDPOINT_REMOVED",
        replacement,
        documentation_url: GUIDE,
      });
      expect(res.headers["deprecation"]).toBe("@1793923200");
      expect(res.headers["sunset"]).toBe(V1_SUNSET);
      expect(res.headers["link"]).toBe(
        `<${GUIDE}>; rel="deprecation", <${replacement}>; rel="successor-version"`,
      );
    },
  );
});
