import request from "supertest";
import dotenv from "dotenv";

dotenv.config();
const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for v0 API Routes", () => {
  beforeAll(() => {
    process.env.USE_DB_AUTHENTICATION = "true";
  });

  afterAll(() => {
    delete process.env.USE_DB_AUTHENTICATION;
  });

  describe("GET /is-production", () => {
    it.concurrent("should return the production status", async () => {
      const response = await request(TEST_URL).get("/is-production");
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("isProduction");
    });
  });

  describe("POST /v0/scrape", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL).post("/v0/scrape");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v0/scrape")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key",
      async () => {
        const response: any = await request(TEST_URL)
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
        const response: any = await request(TEST_URL)
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
      "should return a successful response for a valid scrape with PDF file",
      async () => {
        const response: any = await request(TEST_URL)
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
        const response: any = await request(TEST_URL)
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
      "should return a successful response with a valid API key with removeTags option",
      async () => {
        const responseWithoutRemoveTags: any = await request(TEST_URL)
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

        const response: any = await request(TEST_URL)
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

    it.concurrent(
      "should return a successful response for a scrape with 400 page",
      async () => {
        const response: any = await request(TEST_URL)
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
        const response: any = await request(TEST_URL)
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
        const response: any = await request(TEST_URL)
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
        const response: any = await request(TEST_URL)
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
      },
      60000,
    ); // 60 seconds

    it.concurrent(
      "should return a successful response for a scrape with 500 page",
      async () => {
        const response: any = await request(TEST_URL)
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
      },
      60000,
    ); // 60 seconds
  });

  describe("POST /v0/crawl", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL).post("/v0/crawl");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key for crawl",
      async () => {
        const response: any = await request(TEST_URL)
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
      "should return a successful response with a valid API key and valid includes option",
      async () => {
        const crawlResponse: any = await request(TEST_URL)
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

        let response: any;
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

        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for data to be saved on the database
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

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
      180000,
    ); // 180 seconds

    it.concurrent(
      "should return a successful response with a valid API key and valid excludes option",
      async () => {
        const crawlResponse: any = await request(TEST_URL)
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
        let response: any;

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

        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for data to be saved on the database
        const completedResponse: any = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

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
      "should return a successful response with max depth option for a valid crawl job",
      async () => {
        const crawlResponse: any = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.scrapethissite.com",
            crawlerOptions: { maxDepth: 1 },
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response: any = await request(TEST_URL)
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
        const completedResponse: any = await request(TEST_URL)
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
  });

  describe("POST /v0/crawlWebsitePreview", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL).post(
        "/v0/crawlWebsitePreview",
      );
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v0/crawlWebsitePreview")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a timeout error when scraping takes longer than the specified timeout",
      async () => {
        const response: any = await request(TEST_URL)
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
      60000,
    ); // 60 seconds timeout
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
          .send({ url: "https://firecrawl.dev/blog" });
        expect(crawlResponse.statusCode).toBe(200);

        let isCompleted = false;

        while (!isCompleted) {
          const response = await request(TEST_URL)
            .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(response.statusCode).toBe(200);
          expect(response.body).toHaveProperty("status");

          if (response.body.status === "completed") {
            isCompleted = true;
          } else {
            await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before checking again
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); // wait for data to be saved on the database
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].content).toContain("Firecrawl");
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
            doc.metadata.sourceURL.includes("firecrawl.dev/blog"),
        );

        expect(childrenLinks.length).toBe(completedResponse.body.data.length);
      },
      180000,
    ); // 120 seconds

    // TODO: review the test below
    // it.concurrent('should return a successful response for a valid crawl job with PDF files without explicit .pdf extension ', async () => {
    //   const crawlResponse = await request(TEST_URL)
    //     .post('/v0/crawl')
    //     .set('Authorization', `Bearer ${process.env.TEST_API_KEY}`)
    //     .set('Content-Type', 'application/json')
    //     .send({ url: 'https://arxiv.org/list/astro-ph/1993-01',
    //       crawlerOptions: {
    //         limit: 10,
    //         returnOnlyUrls: true
    //       }});
    //   expect(crawlResponse.statusCode).toBe(200);

    //   let isCompleted = false;
    //   let completedResponse;

    //   while (!isCompleted) {
    //     const response = await request(TEST_URL)
    //       .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
    //       .set('Authorization', `Bearer ${process.env.TEST_API_KEY}`);
    //     expect(response.statusCode).toBe(200);
    //     expect(response.body).toHaveProperty('status');

    //     if (response.body.status === 'completed') {
    //       isCompleted = true;
    //       completedResponse = response;
    //     } else {
    //       await new Promise((r) => setTimeout(r, 1000)); // Wait for 1 second before checking again
    //     }
    //   }
    //     expect(completedResponse.body.status).toBe('completed');
    //     expect(completedResponse.body).toHaveProperty('data');
    //     expect(completedResponse.body.data.length).toEqual(1);
    //     expect(completedResponse.body.data).toEqual(
    //       expect.arrayContaining([
    //         expect.objectContaining({
    //           content: expect.stringContaining('asymmetries might represent, for instance, preferred source orientations to our line of sight.')
    //         })
    //       ])
    //     );

    //     expect(completedResponse.body.data[0]).toHaveProperty("metadata");
    //     expect(completedResponse.body.data[0].metadata.pageStatusCode).toBe(200);
    //     expect(completedResponse.body.data[0].metadata.pageError).toBeUndefined();
    // }, 180000); // 120 seconds

    it.concurrent(
      "If someone cancels a crawl job, it should turn into failed status",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v0/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://docs.tatum.io",
            crawlerOptions: { limit: 200 },
          });

        expect(crawlResponse.statusCode).toBe(200);

        await new Promise(r => setTimeout(r, 10000));

        const responseCancel = await request(TEST_URL)
          .delete(`/v0/crawl/cancel/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(responseCancel.statusCode).toBe(200);
        expect(responseCancel.body).toHaveProperty("status");
        expect(responseCancel.body.status).toBe("cancelled");

        await new Promise(r => setTimeout(r, 10000));
        const completedResponse = await request(TEST_URL)
          .get(`/v0/crawl/status/${crawlResponse.body.jobId}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .maxResponseSize(4000000000);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("failed");
        expect(completedResponse.body).toHaveProperty("data");

        let isNullOrEmptyArray = false;
        if (
          completedResponse.body.data === null ||
          completedResponse.body.data.length === 0
        ) {
          isNullOrEmptyArray = true;
        }
        expect(isNullOrEmptyArray).toBe(true);
        expect(completedResponse.body.data).toEqual(expect.arrayContaining([]));
        expect(completedResponse.body).toHaveProperty("partial_data");
        expect(completedResponse.body.partial_data[0]).toHaveProperty(
          "content",
        );
        expect(completedResponse.body.partial_data[0]).toHaveProperty(
          "markdown",
        );
        expect(completedResponse.body.partial_data[0]).toHaveProperty(
          "metadata",
        );
        expect(
          completedResponse.body.partial_data[0].metadata.pageStatusCode,
        ).toBe(200);
        expect(
          completedResponse.body.partial_data[0].metadata.pageError,
        ).toBeUndefined();
      },
      60000,
    ); // 60 seconds
  });

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
  });
});
