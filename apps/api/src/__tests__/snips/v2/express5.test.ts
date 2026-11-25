import request, { TEST_API_URL, idmux, Identity } from "./lib";
import http from "node:http";
import { gzipSync } from "node:zlib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "express5",
    concurrency: 10,
    credits: 100,
  });
});

describe("Express 5 compatibility", () => {
  it("serves root JSON through the Express app", async () => {
    const response = await request(TEST_API_URL).get("/");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      message: "Firecrawl API",
      documentation_url: "https://docs.firecrawl.dev",
    });
  });

  it("returns the API bad JSON envelope for malformed JSON bodies", async () => {
    const response = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      code: "BAD_REQUEST_INVALID_JSON",
      error: "Bad request, malformed JSON",
    });
  });

  const localApi = ["localhost", "127.0.0.1"].includes(
    new URL(TEST_API_URL).hostname,
  );

  (localApi ? it : it.skip)(
    "keeps serving requests after a gzip body with trailing bytes",
    async () => {
      const gzipBody = gzipSync(Buffer.from('{"ok":true}'));
      const bodyWithTrailingBytes = Buffer.concat([
        gzipBody,
        Buffer.from([0x00]),
        Buffer.alloc(100 * 1024, 0x58),
      ]);
      const headers = {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      };

      const valid = await fetch(`${TEST_API_URL}/e2e-test`, {
        method: "POST",
        headers,
        body: gzipBody,
      });
      expect(valid.status).toBeGreaterThanOrEqual(400);
      expect(valid.status).toBeLessThan(500);
      await valid.arrayBuffer();

      // Send raw bytes so the gzip decoder can finish before the trailing bytes
      // arrive. The older body-parser responded, then crashed the process.
      const responseStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          new URL("/e2e-test", TEST_API_URL),
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Length": bodyWithTrailingBytes.length,
            },
          },
          res => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
        req.end(bodyWithTrailingBytes);
      });
      expect(responseStatus).toBe(valid.status);

      // The vulnerable parser can crash after sending a response.
      await new Promise(resolve => setTimeout(resolve, 200));
      const liveness = await request(TEST_API_URL).get("/e2e-test");
      expect(liveness.statusCode).toBe(200);
    },
  );

  it("still captures route params before validation middleware", async () => {
    const response = await request(TEST_API_URL)
      .get("/v2/crawl/not-a-uuid")
      .set("Authorization", `Bearer ${identity.apiKey}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Invalid job ID format. Job ID must be a valid UUID.",
    });
  });
});
