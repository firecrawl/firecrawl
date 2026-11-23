import express from "express";
import request from "supertest";
import { v0Router } from "../../routes/v0";

const GUIDE = "https://docs.firecrawl.dev/migrating-from-v0";

function appUnderTest() {
  const app = express();
  app.use(v0Router);
  return app;
}

describe("removed v0 API", () => {
  it.each([
    ["post", "/v0/scrape", "/v2/scrape"],
    ["post", "/v0/crawl", "/v2/crawl"],
    ["get", "/v0/crawl/status/abc", "/v2/crawl/:jobId"],
    ["delete", "/v0/crawl/cancel/abc", "/v2/crawl/:jobId"],
    ["get", "/v0/keyAuth", "/v2/team/credit-usage"],
    ["post", "/v0/search", "/v2/search"],
  ] as const)(
    "%s %s answers 410 with the migration guide, without an API key",
    async (method, path, replacement) => {
      const res = await request(appUnderTest())[method](path);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({
        success: false,
        code: "ENDPOINT_REMOVED",
        replacement,
        documentation_url: GUIDE,
      });
      expect(res.headers["deprecation"]).toBe("@1778025600");
      expect(res.headers["sunset"]).toBe("Thu, 10 Dec 2026 15:00:00 GMT");
      expect(res.headers["link"]).toBe(
        `<${GUIDE}>; rel="deprecation", <${replacement}>; rel="successor-version"`,
      );
    },
  );

  it.each(["/v0/health/liveness", "/v0/health/readiness"])(
    "keeps %s as a health alias",
    async path => {
      const res = await request(appUnderTest()).get(path);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    },
  );
});
