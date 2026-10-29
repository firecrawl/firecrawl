import express from "express";
import request from "supertest";
import { notFoundHandler } from "../../lib/not-found";

// A stand-in for the real app's mount structure: a versioned router mounted
// under a prefix, a sub-router mounted inside it, and a root descriptor. The
// real routers pull in the whole service graph, so the shape is replayed here
// rather than imported.
function appUnderTest() {
  const app = express();

  app.get("/", (_req, res) => {
    res.json({
      message: "Firecrawl API",
      documentation_url: "https://docs.firecrawl.dev",
    });
  });

  const nested = express.Router();
  nested.post("/", (_req, res) => res.status(200).json({ success: true }));
  nested.delete("/", (_req, res) => res.status(200).json({ success: true }));

  const v2 = express.Router();
  v2.post("/scrape", (_req, res) => res.status(200).json({ success: true }));
  v2.post("/search", (_req, res) => res.status(200).json({ success: true }));
  v2.get("/crawl/:id", (_req, res) => res.status(200).json({ success: true }));
  v2.delete("/crawl/:id", (_req, res) =>
    res.status(200).json({ success: true }),
  );
  v2.post("/scrape/:jobId/interact", (_req, res) =>
    res.status(200).json({ success: true }),
  );
  v2.delete("/scrape/:jobId/interact", (_req, res) =>
    res.status(200).json({ success: true }),
  );
  v2.use("/developer", nested);

  // Mounted with no path, the way `v0Router` and `adminRouter` are in
  // src/index.ts. Express flags such a layer as matching everything and never
  // consults its matchers, so the walk has to handle it explicitly.
  const rootMounted = express.Router();
  rootMounted.post("/v0/scrape", (_req, res) =>
    res.status(200).json({ success: true }),
  );
  rootMounted.get("/v0/health/liveness", (_req, res) =>
    res.status(200).json({ success: true }),
  );

  const adminMounted = express.Router();
  adminMounted.post("/admin/:key/queues", (_req, res) =>
    res.status(200).json({ success: true }),
  );

  app.use("/v2", v2);
  app.use(rootMounted);
  app.use(adminMounted);
  app.use(notFoundHandler);
  return app;
}

describe("terminal not-found handler", () => {
  it("answers an unknown path with JSON, not Express's HTML page", async () => {
    const res = await request(appUnderTest()).get("/v2/nonexistent-xyz");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.text).not.toContain("Cannot GET");
    expect(res.body).toEqual({
      success: false,
      code: "NOT_FOUND",
      error: "GET /v2/nonexistent-xyz is not a Firecrawl API endpoint.",
      documentation_url:
        "https://docs.firecrawl.dev/api-reference/introduction",
    });
  });

  it.each(["/v2/scrape", "/v2/search"])(
    "answers GET %s with 405 and an Allow header",
    async path => {
      const res = await request(appUnderTest()).get(path);

      expect(res.status).toBe(405);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["allow"]).toBe("POST");
      expect(res.text).not.toContain("Cannot GET");
      expect(res.body.code).toBe("METHOD_NOT_ALLOWED");
      expect(res.body.allowed_methods).toEqual(["POST"]);
      expect(res.body.documentation_url).toBe(
        "https://docs.firecrawl.dev/api-reference/introduction",
      );
    },
  );

  it("lists every other method for a path that has several", async () => {
    const res = await request(appUnderTest()).post("/v2/crawl/abc");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("DELETE, GET, HEAD");
    expect(res.body.allowed_methods).toEqual(["DELETE", "GET", "HEAD"]);
  });

  it("answers GET on the interact path with 405, not Cannot GET", async () => {
    const res = await request(appUnderTest()).get("/v2/scrape/abc/interact");

    expect(res.status).toBe(405);
    expect(res.text).not.toContain("Cannot GET");
    expect(res.headers["allow"]).toBe("DELETE, POST");
  });

  it("resolves paths inside a mounted sub-router", async () => {
    const res = await request(appUnderTest()).get("/v2/developer");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("DELETE, POST");
  });

  it("answers GET on a POST-only route in a root-mounted router with 405", async () => {
    const res = await request(appUnderTest()).get("/v0/scrape");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
    expect(res.text).not.toContain("Cannot GET");
    expect(res.body.code).toBe("METHOD_NOT_ALLOWED");
    expect(res.body.allowed_methods).toEqual(["POST"]);
  });

  it("answers POST on a GET-only route in a root-mounted router with 405", async () => {
    const res = await request(appUnderTest()).post("/v0/health/liveness");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
    expect(res.body.allowed_methods).toEqual(["GET", "HEAD"]);
  });

  it("resolves admin paths in a second root-mounted router", async () => {
    const res = await request(appUnderTest()).get("/admin/secret/queues");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
  });

  it("still answers an unknown path under a root mount with a JSON 404", async () => {
    const res = await request(appUnderTest()).get("/v0/nonexistent-xyz");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["allow"]).toBeUndefined();
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("leaves existing routes alone", async () => {
    const app = appUnderTest();

    const scrape = await request(app).post("/v2/scrape");
    expect(scrape.status).toBe(200);
    expect(scrape.body).toEqual({ success: true });

    const status = await request(app).get("/v2/crawl/abc");
    expect(status.status).toBe(200);

    const interact = await request(app).post("/v2/scrape/abc/interact");
    expect(interact.status).toBe(200);

    const developer = await request(app).post("/v2/developer");
    expect(developer.status).toBe(200);

    const root = await request(app).get("/");
    expect(root.status).toBe(200);
    expect(root.body.message).toBe("Firecrawl API");

    const v0Scrape = await request(app).post("/v0/scrape");
    expect(v0Scrape.status).toBe(200);
    expect(v0Scrape.body).toEqual({ success: true });

    const liveness = await request(app).get("/v0/health/liveness");
    expect(liveness.status).toBe(200);

    const admin = await request(app).post("/admin/secret/queues");
    expect(admin.status).toBe(200);
  });
});
