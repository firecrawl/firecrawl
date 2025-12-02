import request from "supertest";
import dotenv from "dotenv";
import { v7 as uuidv7 } from "uuid";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";

dotenv.config();

// const TEST_URL = 'http://localhost:3002'
const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for API Routes", () => {
  beforeAll(() => {
    process.env.USE_DB_AUTHENTICATION = "true";
  });

  afterAll(() => {
    delete process.env.USE_DB_AUTHENTICATION;
  });

  describe("GET /e2e-test", () => {
    it.concurrent("should return OK message", async () => {
      const response = await request(TEST_URL).get("/e2e-test");
      expect(response.statusCode).toBe(200);
      expect(response.text).toContain("OK");
    });
  });

  describe("POST /v0/scrape", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/scrape");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent("should return an error for a blocklisted URL", async () => {
      const blocklistedUrl = "https://facebook.com/fake-test";
      const response = await request(TEST_URL)
        .post("/v0/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: blocklistedUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toContain(BLOCKLISTED_URL_MESSAGE);
    });

    it.concurrent(
      "should return a successful response with a valid API key",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://roastmywebsite.ai" });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data.content).toContain("_Roast_");
        expect(response.body.data.metadata).toHaveProperty("title");
        expect(response.body.data.metadata).toHaveProperty("description");
        expect(response.body.data.metadata).toHaveProperty("keywords");
        expect(response.body.data.metadata).toHaveProperty("robots");
        expect(response.body.data.metadata).toHaveProperty("ogTitle");
        expect(response.body.data.metadata).toHaveProperty("ogDescription");
        expect(response.body.data.metadata).toHaveProperty("ogUrl");
        expect(response.body.data.metadata).toHaveProperty("ogImage");
        expect(response.body.data.metadata).toHaveProperty("ogLocaleAlternate");
        expect(response.body.data.metadata).toHaveProperty("ogSiteName");
        expect(response.body.data.metadata).toHaveProperty("sourceURL");
        expect(response.body.data.metadata).toHaveProperty("pageStatusCode");
        expect(response.body.data.metadata.pageError).toBeUndefined();
        expect(response.body.data.metadata.title).toBe("Roast My Website");
        expect(response.body.data.metadata.description).toBe(
          "Welcome to Roast My Website, the ultimate tool for putting your website through the wringer! This repository harnesses the power of Firecrawl to scrape and capture screenshots of websites, and then unleashes the latest LLM vision models to mercilessly roast them. 🌶️",
        );
        expect(response.body.data.metadata.keywords).toBe(
          "Roast My Website,Roast,Website,GitHub,Firecrawl",
        );
        expect(response.body.data.metadata.robots).toBe("follow, index");
        expect(response.body.data.metadata.ogTitle).toBe("Roast My Website");
        expect(response.body.data.metadata.ogDescription).toBe(
          "Welcome to Roast My Website, the ultimate tool for putting your website through the wringer! This repository harnesses the power of Firecrawl to scrape and capture screenshots of websites, and then unleashes the latest LLM vision models to mercilessly roast them. 🌶️",
        );
        expect(response.body.data.metadata.ogUrl).toBe(
          "https://www.roastmywebsite.ai",
        );
        expect(response.body.data.metadata.ogImage).toBe(
          "https://www.roastmywebsite.ai/og.png",
        );
        expect(response.body.data.metadata.ogLocaleAlternate).toStrictEqual([]);
        expect(response.body.data.metadata.ogSiteName).toBe("Roast My Website");
        expect(response.body.data.metadata.sourceURL).toBe(
          "https://roastmywebsite.ai",
        );
        expect(response.body.data.metadata.pageStatusCode).toBe(200);
      },
      30000,
    ); // 30 seconds timeout

    it.concurrent(
      "should return a successful response with a valid API key and includeHtml set to true",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://roastmywebsite.ai",
            pageOptions: { includeHtml: true },
          });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("html");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.content).toContain("_Roast_");
        expect(response.body.data.markdown).toContain("_Roast_");
        expect(response.body.data.html).toContain("<h1");
        expect(response.body.data.metadata.pageStatusCode).toBe(200);
        expect(response.body.data.metadata.pageError).toBeUndefined();
      },
      30000,
    ); // 30 seconds timeout

    it.concurrent(
      "should return a successful response with a valid API key and includeRawHtml set to true",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://roastmywebsite.ai",
            pageOptions: { includeRawHtml: true },
          });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("rawHtml");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.content).toContain("_Roast_");
        expect(response.body.data.markdown).toContain("_Roast_");
        expect(response.body.data.rawHtml).toContain("<h1");
        expect(response.body.data.metadata.pageStatusCode).toBe(200);
        expect(response.body.data.metadata.pageError).toBeUndefined();
      },
      30000,
    ); // 30 seconds timeout

    it.concurrent(
      "should return a successful response for a valid scrape with PDF file",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://arxiv.org/pdf/astro-ph/9301001.pdf" });
        await new Promise(r => setTimeout(r, 6000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.content).toContain(
          "We present spectrophotometric observations of the Broad Line Radio Galaxy",
        );
        expect(response.body.data.metadata.pageStatusCode).toBe(200);
        expect(response.body.data.metadata.pageError).toBeUndefined();
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a valid scrape with PDF file without explicit .pdf extension",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://arxiv.org/pdf/astro-ph/9301001" });
        await new Promise(r => setTimeout(r, 6000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.content).toContain(
          "We present spectrophotometric observations of the Broad Line Radio Galaxy",
        );
        expect(response.body.data.metadata.pageStatusCode).toBe(200);
        expect(response.body.data.metadata.pageError).toBeUndefined();
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a valid scrape with PDF file and parsePDF set to false",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://arxiv.org/pdf/astro-ph/9301001.pdf",
            pageOptions: { parsePDF: false },
          });
        await new Promise(r => setTimeout(r, 6000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.content).toContain(
          "/Title(arXiv:astro-ph/9301001v1  7 Jan 1993)>>endobj",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response with a valid API key with removeTags option",
      async () => {
        const responseWithoutRemoveTags = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://www.scrapethissite.com/" });
        expect(responseWithoutRemoveTags.statusCode).toBe(200);
        expect(responseWithoutRemoveTags.body).toHaveProperty("data");
        expect(responseWithoutRemoveTags.body.data).toHaveProperty("content");
        expect(responseWithoutRemoveTags.body.data).toHaveProperty("markdown");
        expect(responseWithoutRemoveTags.body.data).toHaveProperty("metadata");
        expect(responseWithoutRemoveTags.body.data).not.toHaveProperty("html");
        expect(responseWithoutRemoveTags.body.data.content).toContain(
          "Scrape This Site",
        );
        expect(responseWithoutRemoveTags.body.data.content).toContain(
          "Lessons and Videos",
        ); // #footer
        expect(responseWithoutRemoveTags.body.data.content).toContain(
          "[Sandbox](",
        ); // .nav
        expect(responseWithoutRemoveTags.body.data.content).toContain(
          "web scraping",
        ); // strong

        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.scrapethissite.com/",
            pageOptions: { removeTags: [".nav", "#footer", "strong"] },
          });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data.content).toContain("Scrape This Site");
        expect(response.body.data.content).not.toContain("Lessons and Videos"); // #footer
        expect(response.body.data.content).not.toContain("[Sandbox]("); // .nav
        expect(response.body.data.content).not.toContain("web scraping"); // strong
      },
      30000,
    ); // 30 seconds timeout

    // TODO: add this test back once we nail the waitFor option to be more deterministic
    // it.concurrent("should return a successful response with a valid API key and waitFor option", async () => {
    //   const startTime = Date.now();
    //   const response = await request(TEST_URL)
    //     .post("/v0/scrape")
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
    //     .set("Content-Type", "application/json")
    //     .send({ url: "https://firecrawl.dev", pageOptions: { waitFor: 7000 } });
    //   const endTime = Date.now();
    //   const duration = endTime - startTime;

    //   expect(response.statusCode).toBe(200);
    //   expect(response.body).toHaveProperty("data");
    //   expect(response.body.data).toHaveProperty("content");
    //   expect(response.body.data).toHaveProperty("markdown");
    //   expect(response.body.data).toHaveProperty("metadata");
    //   expect(response.body.data).not.toHaveProperty("html");
    //   expect(response.body.data.content).toContain("🔥 Firecrawl");
    //   expect(duration).toBeGreaterThanOrEqual(7000);
    // }, 12000); // 12 seconds timeout

    it.concurrent(
      "should return a successful response for a scrape with 400 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/400" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(400);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "bad request",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 401 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/401" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(401);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "unauthorized",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 403 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/403" });

        await new Promise(r => setTimeout(r, 5000));
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(403);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "forbidden",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 404 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/404" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(404);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "not found",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 405 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/405" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(405);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "method not allowed",
        );
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 500 page",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/500" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        expect(response.body.data).toHaveProperty("content");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.pageStatusCode).toBe(500);
        expect(response.body.data.metadata.pageError.toLowerCase()).toContain(
          "internal server error",
        );
      },
      60000,
    ); // 60 seconds
  });

  describe("POST /v0/crawl", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/crawl");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent("should return an error for a blocklisted URL", async () => {
      const blocklistedUrl = "https://twitter.com/fake-test";
      const response = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: blocklistedUrl });
      expect(response.statusCode).toBe(403);
      expect(response.body.error).toContain(BLOCKLISTED_URL_MESSAGE);
    });

    it.concurrent(
      "should return a successful response with a valid API key for crawl",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("jobId");
        expect(response.body.jobId).toMatch(
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
        );
      },
    );
    it.concurrent(
      "should prevent duplicate requests using the same idempotency key",
      async () => {
        const uniqueIdempotencyKey = uuidv7();

        // First request with the idempotency key
        const firstResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .set("x-idempotency-key", uniqueIdempotencyKey)
          .send({ url: "https://docs.firecrawl.dev" });

        expect(firstResponse.statusCode).toBe(200);

        // Second request with the same idempotency key
        const secondResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .set("x-idempotency-key", uniqueIdempotencyKey)
          .send({ url: "https://docs.firecrawl.dev" });

        expect(secondResponse.statusCode).toBe(409);
        expect(secondResponse.body.error).toBe("Idempotency key already used");
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key and valid includes option",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",
            limit: 10,
            crawlerOptions: {
              includes: ["blog/*"],
            },
          });

        let response;
        let isFinished = false;

        while (!isFinished) {
          response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");
          isFinished = response.body.status === "completed";

          if (!isFinished) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        const completedResponse = response;

        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(5);
        urls.forEach((url: string) => {
          expect(url.startsWith("https://www.mendable.ai/blog/")).toBeTruthy();
        });

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].content).toContain("Mendable");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response with a valid API key and valid excludes option",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",
            limit: 10,
            crawlerOptions: {
              excludes: ["blog/*"],
            },
          });

        let isFinished = false;
        let response;

        while (!isFinished) {
          response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");
          isFinished = response.body.status === "completed";

          if (!isFinished) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        const completedResponse = response;

        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(5);
        urls.forEach((url: string) => {
          expect(url.startsWith("https://wwww.mendable.ai/blog/")).toBeFalsy();
        });
      },
      90000,
    ); // 90 seconds

    it.concurrent(
      "should return a successful response with a valid API key and limit to 3",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",
            crawlerOptions: { limit: 3 },
          });

        let isFinished = false;
        let response;

        while (!isFinished) {
          response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");
          isFinished = response.body.status === "completed";

          if (!isFinished) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        const completedResponse = response;

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data.length).toBe(3);
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].content).toContain("Mendable");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response with max depth option for a valid crawl job",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.scrapethissite.com",
            crawlerOptions: { maxDepth: 1 },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting"]).toContain(response.body.status);
        // wait for 60 seconds
        let isCompleted = false;
        while (!isCompleted) {
          const statusCheckResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(statusCheckResponse.statusCode).toBe(200);
          isCompleted = statusCheckResponse.body.status === "completed";
          if (!isCompleted) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(1);

        // Check if all URLs have a maximum depth of 1
        urls.forEach((url: string) => {
          const pathSplits = new URL(url).pathname.split("/");
          const depth =
            pathSplits.length -
            (pathSplits[0].length === 0 &&
            pathSplits[pathSplits.length - 1].length === 0
              ? 1
              : 0);
          expect(depth).toBeLessThanOrEqual(2);
        });
      },
      180000,
    );

    it.concurrent(
      "should return a successful response with relative max depth option for a valid crawl job",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.scrapethissite.com/pages/",
            crawlerOptions: { maxDepth: 1 },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting"]).toContain(response.body.status);
        // wait for 60 seconds
        let isCompleted = false;
        while (!isCompleted) {
          const statusCheckResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(statusCheckResponse.statusCode).toBe(200);
          isCompleted = statusCheckResponse.body.status === "completed";
          if (!isCompleted) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(1);

        // Check if all URLs have an absolute maximum depth of 3 after the base URL depth was 2 and the maxDepth was 1
        urls.forEach((url: string) => {
          const pathSplits = new URL(url).pathname.split("/");
          const depth =
            pathSplits.length -
            (pathSplits[0].length === 0 &&
            pathSplits[pathSplits.length - 1].length === 0
              ? 1
              : 0);
          expect(depth).toBeLessThanOrEqual(3);
        });
      },
      180000,
    );

    it.concurrent(
      "should return a successful response with relative max depth option for a valid crawl job with maxDepths equals to zero",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.mendable.ai",
            crawlerOptions: { maxDepth: 0 },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting"]).toContain(response.body.status);
        // wait for 60 seconds
        let isCompleted = false;
        while (!isCompleted) {
          const statusCheckResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(statusCheckResponse.statusCode).toBe(200);
          isCompleted = statusCheckResponse.body.status === "completed";
          if (!isCompleted) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        const testurls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        //console.log(testurls)

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThanOrEqual(1);

        // Check if all URLs have an absolute maximum depth of 3 after the base URL depth was 2 and the maxDepth was 1
        urls.forEach((url: string) => {
          const pathSplits = new URL(url).pathname.split("/");
          const depth =
            pathSplits.length -
            (pathSplits[0].length === 0 &&
            pathSplits[pathSplits.length - 1].length === 0
              ? 1
              : 0);
          expect(depth).toBeLessThanOrEqual(1);
        });
      },
      180000,
    );

    // it.concurrent("should return a successful response with a valid API key and valid limit option", async () => {
    //   const crawlResponse = await request(TEST_URL)
    //     .post("/v0/crawl")
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
    //     .set("Content-Type", "application/json")
    //     .send({
    //       url: "https://mendable.ai",
    //       crawlerOptions: { limit: 10 },
    //     });

    //   const response = await request(TEST_URL)
    //     .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
    //   expect(response.statusCode).toBe(200);
    //   expect(response.body).toHaveProperty("status");
    //   expect(response.body.status).toBe("active");

    //   let isCompleted = false;
    //   while (!isCompleted) {
    //     const statusCheckResponse = await request(TEST_URL)
    //       .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
    //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
    //     expect(statusCheckResponse.statusCode).toBe(200);
    //     isCompleted = statusCheckResponse.body.status === "completed";
    //     if (!isCompleted) {
    //       await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
    //     }
    //   }

    //   const completedResponse = await request(TEST_URL)
    //     .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

    //   expect(completedResponse.statusCode).toBe(200);
    //   expect(completedResponse.body).toHaveProperty("status");
    //   expect(completedResponse.body.status).toBe("completed");
    //   expect(completedResponse.body).toHaveProperty("data");
    //   expect(completedResponse.body.data.length).toBe(10);
    //   expect(completedResponse.body.data[0]).toHaveProperty("content");
    //   expect(completedResponse.body.data[0]).toHaveProperty("markdown");
    //   expect(completedResponse.body.data[0]).toHaveProperty("metadata");
    //   expect(completedResponse.body.data[0].content).toContain("Mendable");
    //   expect(completedResponse.body.data[0].content).not.toContain("main menu");
    // }, 60000); // 60 seconds

    it.concurrent(
      "should return a successful response for a valid crawl job with includeHtml set to true option",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://roastmywebsite.ai",
            pageOptions: { includeHtml: true },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting"]).toContain(response.body.status);

        let isCompleted = false;
        while (!isCompleted) {
          const statusCheckResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(statusCheckResponse.statusCode).toBe(200);
          isCompleted = statusCheckResponse.body.status === "completed";
          if (!isCompleted) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();

        // 120 seconds
        expect(completedResponse.body.data[0]).toHaveProperty("html");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].content).toContain("_Roast_");
        expect(completedResponse.body.data[0].markdown).toContain("_Roast_");
        expect(completedResponse.body.data[0].html).toContain("<h1");

        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
      },
      180000,
    );

    it.concurrent(
      "should crawl external content links when allowed",
      async () => {
        const crawlInitResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",
            crawlerOptions: {
              allowExternalContentLinks: true,
              ignoreSitemap: true,
              returnOnlyUrls: true,
              limit: 50,
            },
          });

        expect(crawlInitResponse.statusCode).toBe(200);
        expect(crawlInitResponse.body).toHaveProperty("jobId");

        let crawlStatus: string = "scraping";
        let crawlData = [];
        while (crawlStatus !== "completed") {
          const statusResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlInitResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          crawlStatus = statusResponse.body.status;
          if (statusResponse.body.data) {
            crawlData = statusResponse.body.data;
          }
          if (crawlStatus !== "completed") {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }
        expect(crawlData.length).toBeGreaterThan(0);
        expect(crawlData).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              url: expect.stringContaining(
                "https://firecrawl.dev/?ref=mendable+banner",
              ),
            }),
            expect.objectContaining({
              url: expect.stringContaining("https://mendable.ai/pricing"),
            }),
            expect.objectContaining({
              url: expect.stringContaining("https://x.com/CalebPeffer"),
            }),
          ]),
        );
      },
      180000,
    ); // 3 minutes timeout
  });

  describe("POST /v0/crawlWebsitePreview", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/crawlWebsitePreview");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/crawlWebsitePreview")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    // it.concurrent("should return an error for a blocklisted URL", async () => {
    //   const blocklistedUrl = "https://instagram.com/fake-test";
    //   const response = await request(TEST_URL)
    //     .post("/v0/crawlWebsitePreview")
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
    //     .set("Content-Type", "application/json")
    //     .send({ url: blocklistedUrl });
    // // is returning 429 instead of 403
    //   expect(response.statusCode).toBe(403);
    //   expect(response.body.error).toContain("Firecrawl currently does not support social media scraping due to policy restrictions. We're actively working on building support for it.");
    // });

    it.concurrent(
      "should return a timeout error when scraping takes longer than the specified timeout",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev", timeout: 1000 });

        expect(response.statusCode).toBe(408);
      },
      3000,
    );
  });

  describe("POST /v0/search", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).post("/v0/search");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/search")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ query: "test" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key for search",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/search")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ query: "test" });
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success");
        expect(response.body.success).toBe(true);
        expect(response.body).toHaveProperty("data");
      },
      30000,
    ); // 30 seconds timeout
  });

  describe("GET /v0/crawl/status/:jobId", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).get("/v0/crawl/status/123");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .get("/v0/crawl/status/123")
          .set("Authorization", `Bearer invalid-api-key`);
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return Job not found for invalid job ID",
      async () => {
        const response = await request(TEST_URL)
          .get("/v0/crawl/status/invalidJobId")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(404);
      },
    );

    it.concurrent(
      "should return a successful crawl status response for a valid crawl job",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://mendable.ai/blog" });
        expect(crawlResponse.statusCode).toBe(200);

        let isCompleted = false;
        let completedResponse;

        while (!isCompleted) {
          const response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");

          if (response.body.status === "completed") {
            isCompleted = true;
            completedResponse = response;
          } else {
            await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before checking again
          }
        }
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].content).toContain("Mendable");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();

        const childrenLinks = completedResponse.body.data.filter(
          doc =>
            doc.metadata &&
            doc.metadata.sourceURL &&
            doc.metadata.sourceURL.includes("mendable.ai/blog"),
        );

        expect(childrenLinks.length).toBe(completedResponse.body.data.length);
      },
      180000,
    ); // 120 seconds

    it.concurrent(
      "should return a successful response for a valid crawl job with PDF files without explicit .pdf extension ",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://arxiv.org/pdf/astro-ph/9301001",
            crawlerOptions: {
              limit: 10,
              excludes: [
                "list/*",
                "login",
                "abs/*",
                "static/*",
                "about/*",
                "archive/*",
              ],
            },
          });
        expect(crawlResponse.statusCode).toBe(200);

        let isCompleted = false;
        let completedResponse;

        while (!isCompleted) {
          const response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");

          if (response.body.status === "completed") {
            isCompleted = true;
            completedResponse = response;
          } else {
            await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before checking again
          }
        }
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data.length).toEqual(1);
        expect(completedResponse.body.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(
                "asymmetries might represent, for instance, preferred source orientations to our line of sight.",
              ),
            }),
          ]),
        );

        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
      },
      180000,
    ); // 120 seconds

    it.concurrent(
      "should return a successful response for a valid crawl job with includeHtml set to true option (2)",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://roastmywebsite.ai",
            pageOptions: { includeHtml: true },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting"]).toContain(response.body.status);

        let isFinished = false;
        let completedResponse;

        while (!isFinished) {
          const response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");

          if (response.body.status === "completed") {
            isFinished = true;
            completedResponse = response;
          } else {
            await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before checking again
          }
        }

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0]).toHaveProperty("html");
        expect(completedResponse.body.data[0].content).toContain("_Roast_");
        expect(completedResponse.body.data[0].markdown).toContain("_Roast_");
        expect(completedResponse.body.data[0].html).toContain("<h1");
        expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(
          200,
        );
        expect(
          completedResponse.body.data[0].metadata.pageError,
        ).toBeUndefined();
      },
      60000,
    );
  }); // 60 seconds

  it.concurrent(
    "should return a successful response for a valid crawl job with allowBackwardCrawling set to true option",
    async () => {
      const crawlResponse = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://mendable.ai/blog",
          pageOptions: { includeHtml: true },
          crawlerOptions: { allowBackwardCrawling: true },
        });
      expect(crawlResponse.statusCode).toBe(200);

      let isFinished = false;
      let completedResponse;

      while (!isFinished) {
        const response = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");

        if (response.body.status === "completed") {
          isFinished = true;
          completedResponse = response;
        } else {
          await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before checking again
        }
      }

      expect(completedResponse.statusCode).toBe(200);
      expect(completedResponse.body).toHaveProperty("status");
      expect(completedResponse.body.status).toBe("completed");
      expect(completedResponse.body).toHaveProperty("data");
      expect(completedResponse.body.data[0]).toHaveProperty("content");
      expect(completedResponse.body.data[0]).toHaveProperty("markdown");
      expect(completedResponse.body.data[0]).toHaveProperty("metadata");
      expect(completedResponse.body.data[0]).toHaveProperty("html");
      expect(completedResponse.body.data[0].content).toContain("Mendable");
      expect(completedResponse.body.data[0].markdown).toContain("Mendable");
      expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(200);
      expect(completedResponse.body.data[0].metadata.pageError).toBeUndefined();

      const onlyChildrenLinks = completedResponse.body.data.filter(doc => {
        return (
          doc.metadata &&
          doc.metadata.sourceURL &&
          doc.metadata.sourceURL.includes("mendable.ai/blog")
        );
      });

      expect(completedResponse.body.data.length).toBeGreaterThan(
        onlyChildrenLinks.length,
      );
    },
    60000,
  );

  it.concurrent(
    "If someone cancels a crawl job, it should turn into failed status",
    async () => {
      const crawlResponse = await request(TEST_URL)
        .post("/v0/crawl")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://jestjs.io" });

      expect(crawlResponse.statusCode).toBe(200);

      await new Promise(r => setTimeout(r, 20000));

      const responseCancel = await request(TEST_URL)
        .delete(`/v0/crawl/cancel/${crawlResponse.body.jobId}`)
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
      expect(responseCancel.statusCode).toBe(200);
      expect(responseCancel.body).toHaveProperty("status");
      expect(responseCancel.body.status).toBe("cancelled");

      await new Promise(r => setTimeout(r, 10000));
      const completedResponse = await request(TEST_URL)
        .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

      expect(completedResponse.statusCode).toBe(200);
      expect(completedResponse.body).toHaveProperty("status");
      expect(completedResponse.body.status).toBe("failed");
      expect(completedResponse.body).toHaveProperty("data");
      expect(completedResponse.body.data).toBeNull();
      expect(completedResponse.body).toHaveProperty("partial_data");
      expect(completedResponse.body.partial_data[0]).toHaveProperty("content");
      expect(completedResponse.body.partial_data[0]).toHaveProperty("markdown");
      expect(completedResponse.body.partial_data[0]).toHaveProperty("metadata");
      expect(
        completedResponse.body.partial_data[0].metadata.pageStatusCode,
      ).toBe(200);
      expect(
        completedResponse.body.partial_data[0].metadata.pageError,
      ).toBeUndefined();
    },
    60000,
  ); // 60 seconds

  describe("POST /v0/scrape with LLM Extraction", () => {
    it.concurrent(
      "should extract data using LLM extraction mode",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",
            pageOptions: {
              onlyMainContent: true,
            },
            extractorOptions: {
              mode: "llm-extraction",
              extractionPrompt:
                "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source",
              extractionSchema: {
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
          });

        // Ensure that the job was successfully created before proceeding with LLM extraction
        expect(response.statusCode).toBe(200);

        // Assuming the LLM extraction object is available in the response body under `data.llm_extraction`
        let llmExtraction = response.body.data.llm_extraction;

        // Check if the llm_extraction object has the required properties with correct types and values
        expect(llmExtraction).toHaveProperty("company_mission");
        expect(typeof llmExtraction.company_mission).toBe("string");
        expect(llmExtraction).toHaveProperty("supports_sso");
        expect(llmExtraction.supports_sso).toBe(true);
        expect(typeof llmExtraction.supports_sso).toBe("boolean");
        expect(llmExtraction).toHaveProperty("is_open_source");
        expect(llmExtraction.is_open_source).toBe(false);
        expect(typeof llmExtraction.is_open_source).toBe("boolean");
      },
      60000,
    ); // 60 secs

    it.concurrent(
      "should extract data using LLM extraction mode with RawHtml",
      async () => {
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://mendable.ai",

            extractorOptions: {
              mode: "llm-extraction-from-raw-html",
              extractionPrompt:
                "Based on the information on the page, what are the primary and secondary CTA buttons?",
              extractionSchema: {
                type: "object",
                properties: {
                  primary_cta: {
                    type: "string",
                  },
                  secondary_cta: {
                    type: "string",
                  },
                },
                required: ["primary_cta", "secondary_cta"],
              },
            },
          });

        // Ensure that the job was successfully created before proceeding with LLM extraction
        expect(response.statusCode).toBe(200);

        // Assuming the LLM extraction object is available in the response body under `data.llm_extraction`
        let llmExtraction = response.body.data.llm_extraction;

        // Check if the llm_extraction object has the required properties with correct types and values
        expect(llmExtraction).toHaveProperty("primary_cta");
        expect(typeof llmExtraction.primary_cta).toBe("string");
        expect(llmExtraction).toHaveProperty("secondary_cta");
        expect(typeof llmExtraction.secondary_cta).toBe("string");
      },
      60000,
    ); // 60 secs
  });

  // describe("POST /v0/scrape for Top 100 Companies", () => {
  //   it.concurrent("should extract data for the top 100 companies", async () => {
  //     const response = await request(TEST_URL)
  //       .post("/v0/scrape")
  //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //       .set("Content-Type", "application/json")
  //       .send({
  //         url: "https://companiesmarketcap.com/",
  //         pageOptions: {
  //           onlyMainContent: true
  //         },
  //         extractorOptions: {
  //           mode: "llm-extraction",
  //           extractionPrompt: "Extract the name, market cap, price, and today's change for the top 20 companies listed on the page.",
  //           extractionSchema: {
  //             type: "object",
  //             properties: {
  //               companies: {
  //                 type: "array",
  //                 items: {
  //                   type: "object",
  //                   properties: {
  //                     rank: { type: "number" },
  //                     name: { type: "string" },
  //                     marketCap: { type: "string" },
  //                     price: { type: "string" },
  //                     todayChange: { type: "string" }
  //                   },
  //                   required: ["rank", "name", "marketCap", "price", "todayChange"]
  //                 }
  //               }
  //             },
  //             required: ["companies"]
  //           }
  //         }
  //       });

  //     // Print the response body to the console for debugging purposes
  //     console.log("Response companies:", response.body.data.llm_extraction.companies);

  //     // Check if the response has the correct structure and data types
  //     expect(response.status).toBe(200);
  //     expect(Array.isArray(response.body.data.llm_extraction.companies)).toBe(true);
  //     expect(response.body.data.llm_extraction.companies.length).toBe(40);

  //     // Sample check for the first company
  //     const firstCompany = response.body.data.llm_extraction.companies[0];
  //     expect(firstCompany).toHaveProperty("name");
  //     expect(typeof firstCompany.name).toBe("string");
  //     expect(firstCompany).toHaveProperty("marketCap");
  //     expect(typeof firstCompany.marketCap).toBe("string");
  //     expect(firstCompany).toHaveProperty("price");
  //     expect(typeof firstCompany.price).toBe("string");
  //     expect(firstCompany).toHaveProperty("todayChange");
  //     expect(typeof firstCompany.todayChange).toBe("string");
  //   }, 120000); // 120 secs
  // });

  describe("POST /v0/crawl with fast mode", () => {
    it.concurrent(
      "should complete the crawl under 20 seconds",
      async () => {
        const startTime = Date.now();

        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://flutterbricks.com",
            crawlerOptions: {
              mode: "fast",
            },
          });

        expect(crawlResponse.statusCode).toBe(200);

        const jobId = crawlResponse.body.jobId;
        let statusResponse;
        let isFinished = false;

        while (!isFinished) {
          statusResponse = await request(TEST_URL)
            .get(`/v0/crawl/status/${jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

          expect(statusResponse.statusCode).toBe(200);
          isFinished = statusResponse.body.status === "completed";

          if (!isFinished) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        // const endTime = Date.now();
        // const timeElapsed = (endTime - startTime) / 1000; // Convert to seconds

        // console.log(`Time elapsed: ${timeElapsed} seconds`);

        expect(statusResponse.body.status).toBe("completed");
        expect(statusResponse.body).toHaveProperty("data");
        expect(statusResponse.body.data[0]).toHaveProperty("content");
        expect(statusResponse.body.data[0]).toHaveProperty("markdown");
        expect(statusResponse.body.data[0]).toHaveProperty("metadata");
        expect(statusResponse.body.data[0].metadata.pageStatusCode).toBe(200);
        expect(statusResponse.body.data[0].metadata.pageError).toBeUndefined();

        const results = statusResponse.body.data;
        // results.forEach((result, i) => {
        //   console.log(result.metadata.sourceURL);
        // });
        expect(results.length).toBeGreaterThanOrEqual(10);
        expect(results.length).toBeLessThanOrEqual(15);
      },
      20000,
    );

    // it.concurrent("should complete the crawl in more than 10 seconds", async () => {
    //   const startTime = Date.now();

    //   const crawlResponse = await request(TEST_URL)
    //     .post("/v0/crawl")
    //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
    //     .set("Content-Type", "application/json")
    //     .send({
    //       url: "https://flutterbricks.com",
    //     });

    //   expect(crawlResponse.statusCode).toBe(200);

    //   const jobId = crawlResponse.body.jobId;
    //   let statusResponse;
    //   let isFinished = false;

    //   while (!isFinished) {
    //     statusResponse = await request(TEST_URL)
    //       .get(`/v0/crawl/status/${jobId}`)
    //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

    //     expect(statusResponse.statusCode).toBe(200);
    //     isFinished = statusResponse.body.status === "completed";

    //     if (!isFinished) {
    //       await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
    //     }
    //   }

    //   const endTime = Date.now();
    //   const timeElapsed = (endTime - startTime) / 1000; // Convert to seconds

    //   console.log(`Time elapsed: ${timeElapsed} seconds`);

    //   expect(statusResponse.body.status).toBe("completed");
    //   expect(statusResponse.body).toHaveProperty("data");
    //   expect(statusResponse.body.data[0]).toHaveProperty("content");
    //   expect(statusResponse.body.data[0]).toHaveProperty("markdown");
    //   const results = statusResponse.body.data;
    //   // results.forEach((result, i) => {
    //   //   console.log(result.metadata.sourceURL);
    //   // });
    //   expect(results.length).toBeGreaterThanOrEqual(10);
    //   expect(results.length).toBeLessThanOrEqual(15);

    // }, 50000);// 15 seconds timeout to account for network delays
  });

  describe("GET /is-production", () => {
    it.concurrent("should return the production status", async () => {
      const response = await request(TEST_URL).get("/is-production");
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("isProduction");
    });
  });

  describe("Rate Limiter", () => {
    it.concurrent(
      "should return 429 when rate limit is exceeded for preview token",
      async () => {
        for (let i = 0; i < 5; i++) {
          const response = await request(TEST_URL)
            .post("/v0/scrape")
            .set("Authorization", `Bearer ${process.env.PREVIEW_TOKEN}`)
            .set("Content-Type", "application/json")
            .send({ url: "https://www.scrapethissite.com" });

          expect(response.statusCode).toBe(200);
        }
        const response = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer ${process.env.PREVIEW_TOKEN}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://www.scrapethissite.com" });

        expect(response.statusCode).toBe(429);
      },
      90000,
    );
  });

  // it.concurrent("should return 429 when rate limit is exceeded for API key", async () => {
  //   for (let i = 0; i < parseInt(process.env.RATE_LIMIT_TEST_API_KEY_SCRAPE); i++) {
  //     const response = await request(TEST_URL)
  //       .post("/v0/scrape")
  //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //       .set("Content-Type", "application/json")
  //       .send({ url: "https://www.scrapethissite.com" });

  //     expect(response.statusCode).toBe(200);
  //   }

  //   const response = await request(TEST_URL)
  //     .post("/v0/scrape")
  //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //     .set("Content-Type", "application/json")
  //     .send({ url: "https://www.scrapethissite.com" });

  //   expect(response.statusCode).toBe(429);
  // }, 60000);

  // it.concurrent("should return 429 when rate limit is exceeded for API key", async () => {
  //   for (let i = 0; i < parseInt(process.env.RATE_LIMIT_TEST_API_KEY_CRAWL); i++) {
  //     const response = await request(TEST_URL)
  //       .post("/v0/crawl")
  //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //       .set("Content-Type", "application/json")
  //       .send({ url: "https://www.scrapethissite.com" });

  //     expect(response.statusCode).toBe(200);
  //   }

  //   const response = await request(TEST_URL)
  //     .post("/v0/crawl")
  //     .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //     .set("Content-Type", "application/json")
  //     .send({ url: "https://www.scrapethissite.com" });

  //   expect(response.statusCode).toBe(429);
  // }, 60000);
});
