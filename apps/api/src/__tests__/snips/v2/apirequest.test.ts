import {
  describeIf,
  concurrentIf,
  itIf,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  HAS_PROXY,
  ALLOW_TEST_SUITE_WEBSITE,
} from "../lib";
import {
  apiRequest,
  apiRequestRaw,
  apiRequestWithFailure,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "apirequest",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("API Request tests", () => {
  describe("Basic functionality", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "GET request works",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/get",
            method: "GET",
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toBeDefined();
        expect(response.metadata.method).toBe("GET");
        expect(response.timing.total).toBeGreaterThan(0);

        // httpbin returns JSON, parse it to verify
        const body = JSON.parse(response.body);
        expect(body.url).toBe("https://httpbin.org/get");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "POST request with JSON body works",
      async () => {
        const testBody = { name: "test", value: 123 };
        const response = await apiRequest(
          {
            url: "https://httpbin.org/post",
            method: "POST",
            body: testBody,
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toBeDefined();
        expect(response.metadata.method).toBe("POST");

        // httpbin echoes back what we sent
        const body = JSON.parse(response.body);
        expect(body.json).toEqual(testBody);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "POST request with string body works",
      async () => {
        const testBody = "Hello, World!";
        const response = await apiRequest(
          {
            url: "https://httpbin.org/post",
            method: "POST",
            body: testBody,
            headers: {
              "Content-Type": "text/plain",
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toBeDefined();

        const body = JSON.parse(response.body);
        expect(body.data).toBe(testBody);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "PUT request works",
      async () => {
        const testBody = { updated: true };
        const response = await apiRequest(
          {
            url: "https://httpbin.org/put",
            method: "PUT",
            body: testBody,
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.metadata.method).toBe("PUT");

        const body = JSON.parse(response.body);
        expect(body.json).toEqual(testBody);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "DELETE request works",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/delete",
            method: "DELETE",
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.metadata.method).toBe("DELETE");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "PATCH request works",
      async () => {
        const testBody = { patched: true };
        const response = await apiRequest(
          {
            url: "https://httpbin.org/patch",
            method: "PATCH",
            body: testBody,
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.metadata.method).toBe("PATCH");

        const body = JSON.parse(response.body);
        expect(body.json).toEqual(testBody);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "HEAD request works",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/get",
            method: "HEAD",
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.metadata.method).toBe("HEAD");
        // HEAD requests should have empty body
        expect(response.body).toBe("");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "OPTIONS request works",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/get",
            method: "OPTIONS",
          },
          identity,
        );

        // httpbin allows OPTIONS
        expect(response.metadata.method).toBe("OPTIONS");
      },
      scrapeTimeout,
    );
  });

  describe("Custom headers", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "custom headers are sent",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/headers",
            method: "GET",
            headers: {
              "X-Custom-Header": "test-value",
              "X-Another-Header": "another-value",
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.headers["X-Custom-Header"]).toBe("test-value");
        expect(body.headers["X-Another-Header"]).toBe("another-value");
      },
      scrapeTimeout,
    );
  });

  describe("Query parameters", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "query params are appended to URL",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/get",
            method: "GET",
            params: {
              foo: "bar",
              baz: "qux",
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.args.foo).toBe("bar");
        expect(body.args.baz).toBe("qux");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "query params are merged with existing URL params",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/get?existing=param",
            method: "GET",
            params: {
              new: "param",
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.args.existing).toBe("param");
        expect(body.args.new).toBe("param");
      },
      scrapeTimeout,
    );
  });

  describe("Response handling", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "response headers are returned",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/response-headers?X-Test=test-value",
            method: "GET",
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        expect(response.headers).toBeDefined();
        expect(response.headers["x-test"]).toBe("test-value");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "handles various status codes",
      async () => {
        // Test 201 Created
        const response201 = await apiRequest(
          {
            url: "https://httpbin.org/status/201",
            method: "GET",
          },
          identity,
        );
        expect(response201.statusCode).toBe(201);

        // Test 204 No Content
        const response204 = await apiRequest(
          {
            url: "https://httpbin.org/status/204",
            method: "GET",
          },
          identity,
        );
        expect(response204.statusCode).toBe(204);
        expect(response204.body).toBe("");

        // Test 404 Not Found
        const response404 = await apiRequest(
          {
            url: "https://httpbin.org/status/404",
            method: "GET",
          },
          identity,
        );
        expect(response404.statusCode).toBe(404);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "follows redirects",
      async () => {
        const response = await apiRequest(
          {
            url: "https://httpbin.org/redirect/1",
            method: "GET",
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
        // Final URL after redirect
        expect(response.url).toContain("httpbin.org/get");
      },
      scrapeTimeout,
    );
  });

  describe("Validation", () => {
    it("rejects body for GET request", async () => {
      const raw = await apiRequestRaw(
        {
          url: "https://httpbin.org/get",
          method: "GET",
          body: { test: "value" },
        } as any,
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.error).toContain("body");
    });

    it("rejects body for DELETE request", async () => {
      const raw = await apiRequestRaw(
        {
          url: "https://httpbin.org/delete",
          method: "DELETE",
          body: { test: "value" },
        } as any,
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.error).toContain("body");
    });

    it("rejects invalid URL", async () => {
      const raw = await apiRequestRaw(
        {
          url: "not-a-valid-url",
          method: "GET",
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    });

    it("rejects non-HTTP protocols", async () => {
      const raw = await apiRequestRaw(
        {
          url: "ftp://example.com/file",
          method: "GET",
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    });

    it("rejects invalid HTTP method", async () => {
      const raw = await apiRequestRaw(
        {
          url: "https://httpbin.org/get",
          method: "INVALID" as any,
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    });
  });

  describeIf(TEST_SELF_HOST)("Security", () => {
    it("blocks private IP addresses", async () => {
      const raw = await apiRequestRaw(
        {
          url: "http://127.0.0.1:8080/test",
          method: "GET",
        },
        identity,
      );

      // Should be blocked unless ALLOW_LOCAL_WEBHOOKS is true
      if (process.env.ALLOW_LOCAL_WEBHOOKS !== "true") {
        expect(raw.statusCode).toBe(403);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toContain("private");
      }
    });

    it("blocks localhost", async () => {
      const raw = await apiRequestRaw(
        {
          url: "http://localhost:8080/test",
          method: "GET",
        },
        identity,
      );

      // Should be blocked unless ALLOW_LOCAL_WEBHOOKS is true
      if (process.env.ALLOW_LOCAL_WEBHOOKS !== "true") {
        expect(raw.statusCode).toBe(403);
        expect(raw.body.success).toBe(false);
      }
    });
  });

  describe("Timeout handling", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "respects timeout setting",
      async () => {
        const raw = await apiRequestRaw(
          {
            url: "https://httpbin.org/delay/10", // 10 second delay
            method: "GET",
            timeout: 2000, // 2 second timeout
          },
          identity,
        );

        expect(raw.statusCode).toBe(408);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toContain("timed out");
      },
      scrapeTimeout,
    );
  });

  describe("Authentication required", () => {
    it("rejects requests without auth", async () => {
      const request = await import("supertest");
      const TEST_API_URL =
        process.env.TEST_API_URL || "http://127.0.0.1:3002";

      const raw = await request.default(TEST_API_URL)
        .post("/v2/apirequest")
        .set("Content-Type", "application/json")
        .send({
          url: "https://httpbin.org/get",
          method: "GET",
        });

      expect(raw.statusCode).toBe(401);
    });
  });
});
