import request from "supertest";
import { configDotenv } from "dotenv";
import { ScrapeRequestInput } from "../../controllers/v1/types";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";

configDotenv();
const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for v1 API Routes", () => {
  beforeAll(() => {
    process.env.USE_DB_AUTHENTICATION = "true";
  });

  afterAll(() => {
    delete process.env.USE_DB_AUTHENTICATION;
  });

  describe("GET /is-production", () => {
    it.concurrent("should return the production status", async () => {
      const response: any = await request(TEST_URL).get("/is-production");

      console.log(
        "process.env.USE_DB_AUTHENTICATION",
        process.env.USE_DB_AUTHENTICATION,
      );
      console.log("?", process.env.USE_DB_AUTHENTICATION === "true");
      const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
      console.log("!!useDbAuthentication", !!useDbAuthentication);
      console.log("!useDbAuthentication", !useDbAuthentication);

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("isProduction");
    });
  });

  describe("POST /v1/scrape", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL)
        .post("/v1/scrape")
        .send({ url: "https://firecrawl.dev" });

      expect(response.statusCode).toBe(401);
    });

    it.concurrent("should throw error for blocklisted URL", async () => {
      const scrapeRequest: ScrapeRequestInput = {
        url: "https://facebook.com/fake-test",
      };

      const response = await request(TEST_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(403);
      expect(response.body.error).toBe(BLOCKLISTED_URL_MESSAGE);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://roastmywebsite.ai",
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);

        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).not.toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data.markdown).toContain("_Roast_");
        expect(response.body.data.metadata.error).toBeUndefined();
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
        expect(response.body.data.metadata.statusCode).toBe(200);
      },
      30000,
    ); // 30 seconds timeout

    it.concurrent(
      "should return a successful response with a valid API key",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://arxiv.org/abs/2410.04840",
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);

        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).not.toHaveProperty("content");
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data.markdown).toContain("Strong Model Collapse");
        expect(response.body.data.metadata.error).toBeUndefined();
        expect(response.body.data.metadata.description).toContain(
          "Abstract page for arXiv paper 2410.04840: Strong Model Collapse",
        );
        expect(response.body.data.metadata.citation_title).toBe(
          "Strong Model Collapse",
        );
        expect(response.body.data.metadata.citation_author).toEqual([
          "Dohmatob, Elvis",
          "Feng, Yunzhen",
          "Subramonian, Arjun",
          "Kempe, Julia",
        ]);
        expect(response.body.data.metadata.citation_date).toBe("2024/10/07");
        expect(response.body.data.metadata.citation_online_date).toBe(
          "2024/10/08",
        );
        expect(response.body.data.metadata.citation_pdf_url).toBe(
          "http://arxiv.org/pdf/2410.04840",
        );
        expect(response.body.data.metadata.citation_arxiv_id).toBe(
          "2410.04840",
        );
        expect(response.body.data.metadata.citation_abstract).toContain(
          "Within the scaling laws paradigm",
        );
        expect(response.body.data.metadata.sourceURL).toBe(
          "https://arxiv.org/abs/2410.04840",
        );
        expect(response.body.data.metadata.statusCode).toBe(200);
      },
      30000,
    );
    it.concurrent(
      "should return a successful response with a valid API key and includeHtml set to true",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://roastmywebsite.ai",
          formats: ["markdown", "html"],
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("html");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.markdown).toContain("_Roast_");
        expect(response.body.data.html).toContain("<h1");
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      30000,
    );
    it.concurrent(
      "should return a successful response for a valid scrape with PDF file",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://arxiv.org/pdf/astro-ph/9301001.pdf",
          //   formats: ["markdown", "html"],
        };
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);
        await new Promise(r => setTimeout(r, 6000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.markdown).toContain(
          "Broad Line Radio Galaxy",
        );
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      60000,
    );

    it.concurrent(
      "should return a successful response for a valid scrape with PDF file without explicit .pdf extension",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://arxiv.org/pdf/astro-ph/9301001",
        };
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);
        await new Promise(r => setTimeout(r, 6000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.markdown).toContain(
          "Broad Line Radio Galaxy",
        );
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      60000,
    );

    it.concurrent(
      "should return a successful response with a valid API key with removeTags option",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://www.scrapethissite.com/",
          onlyMainContent: false, // default is true
        };
        const responseWithoutRemoveTags: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);
        expect(responseWithoutRemoveTags.statusCode).toBe(200);
        expect(responseWithoutRemoveTags.body).toHaveProperty("data");

        if (!("data" in responseWithoutRemoveTags.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(responseWithoutRemoveTags.body.data).toHaveProperty("markdown");
        expect(responseWithoutRemoveTags.body.data).toHaveProperty("metadata");
        expect(responseWithoutRemoveTags.body.data).not.toHaveProperty("html");
        expect(responseWithoutRemoveTags.body.data.markdown).toContain(
          "[FAQ](/faq/)",
        ); // .nav
        expect(responseWithoutRemoveTags.body.data.markdown).toContain(
          "Hartley Brody 2023",
        ); // #footer

        const scrapeRequestWithRemoveTags: ScrapeRequestInput = {
          url: "https://www.scrapethissite.com/",
          excludeTags: [".nav", "#footer", "strong"],
          onlyMainContent: false, // default is true
        };
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequestWithRemoveTags);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data.markdown).not.toContain("Hartley Brody 2023");
        expect(response.body.data.markdown).not.toContain("[FAQ](/faq/)"); //
      },
      30000,
    );

    it.concurrent(
      "should return a successful response for a scrape with 400 page",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/400" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.statusCode).toBe(400);
      },
      60000,
    );

    it.concurrent(
      "should return a successful response for a scrape with 401 page",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/401" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.statusCode).toBe(401);
      },
      60000,
    );

    // Removed it as we want to retry fallback to the next scraper
    // it.concurrent('should return a successful response for a scrape with 403 page', async () => {
    //   const response: any = await request(TEST_URL)
    //     .post('/v1/scrape')
    //     .set('Authorization', `Bearer ${process.env.TEST_API_KEY}`)
    //     .set('Content-Type', 'application/json')
    //     .send({ url: 'https://httpstat.us/403' });
    //   await new Promise((r) => setTimeout(r, 5000));

    //   expect(response.statusCode).toBe(200);
    //   expect(response.body).toHaveProperty('data');
    //   if (!("data" in response.body)) {
    //     throw new Error("Expected response body to have 'data' property");
    //   }
    //   expect(response.body.data).toHaveProperty('markdown');
    //   expect(response.body.data).toHaveProperty('metadata');
    //   expect(response.body.data.metadata.statusCode).toBe(403);
    // }, 60000);

    it.concurrent(
      "should return a successful response for a scrape with 404 page",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://httpstat.us/404" });
        await new Promise(r => setTimeout(r, 5000));

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.metadata.statusCode).toBe(404);
      },
      60000,
    );

    // it.concurrent('should return a successful response for a scrape with 405 page', async () => {
    //   const response: any = await request(TEST_URL)
    //     .post('/v1/scrape')
    //     .set('Authorization', `Bearer ${process.env.TEST_API_KEY}`)
    //     .set('Content-Type', 'application/json')
    //     .send({ url: 'https://httpstat.us/405' });
    //   await new Promise((r) => setTimeout(r, 5000));

    //   expect(response.statusCode).toBe(200);
    //   expect(response.body).toHaveProperty('data');
    //   if (!("data" in response.body)) {
    //     throw new Error("Expected response body to have 'data' property");
    //   }
    //   expect(response.body.data).toHaveProperty('markdown');
    //   expect(response.body.data).toHaveProperty('metadata');
    //   expect(response.body.data.metadata.statusCode).toBe(405);
    // }, 60000);

    // it.concurrent('should return a successful response for a scrape with 500 page', async () => {
    //   const response: any = await request(TEST_URL)
    //     .post('/v1/scrape')
    //     .set('Authorization', `Bearer ${process.env.TEST_API_KEY}`)
    //     .set('Content-Type', 'application/json')
    //     .send({ url: 'https://httpstat.us/500' });
    //   await new Promise((r) => setTimeout(r, 5000));

    //   expect(response.statusCode).toBe(200);
    //   expect(response.body).toHaveProperty('data');
    //   if (!("data" in response.body)) {
    //     throw new Error("Expected response body to have 'data' property");
    //   }
    //   expect(response.body.data).toHaveProperty('markdown');
    //   expect(response.body.data).toHaveProperty('metadata');
    //   expect(response.body.data.metadata.statusCode).toBe(500);
    // }, 60000);

    it.concurrent(
      "should return a timeout error when scraping takes longer than the specified timeout",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev", timeout: 1000 });

        expect(response.statusCode).toBe(408);
      },
      3000,
    );

    it.concurrent(
      "should return a successful response with a valid API key and includeHtml set to true",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://roastmywebsite.ai",
          formats: ["html", "rawHtml"],
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).not.toHaveProperty("markdown");
        expect(response.body.data).toHaveProperty("html");
        expect(response.body.data).toHaveProperty("rawHtml");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.html).toContain("<h1");
        expect(response.body.data.rawHtml).toContain("<html");
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      30000,
    );

    it.concurrent(
      "should return a successful response with waitFor",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://ycombinator.com/companies",
          formats: ["markdown"],
          waitFor: 8000,
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).toHaveProperty("markdown");
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data).not.toHaveProperty("links");
        expect(response.body.data).not.toHaveProperty("rawHtml");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.markdown).toContain("PagerDuty");
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      30000,
    );

    it.concurrent(
      "should return a successful response with a valid links on page",
      async () => {
        const scrapeRequest: ScrapeRequestInput = {
          url: "https://roastmywebsite.ai",
          formats: ["links"],
        };

        const response: any = await request(TEST_URL)
          .post("/v1/scrape")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(scrapeRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("data");
        if (!("data" in response.body)) {
          throw new Error("Expected response body to have 'data' property");
        }
        expect(response.body.data).not.toHaveProperty("html");
        expect(response.body.data).not.toHaveProperty("rawHtml");
        expect(response.body.data).toHaveProperty("links");
        expect(response.body.data).toHaveProperty("metadata");
        expect(response.body.data.links).toContain("https://firecrawl.dev");
        expect(response.body.data.metadata.statusCode).toBe(200);
        expect(response.body.data.metadata.error).toBeUndefined();
      },
      30000,
    );
  });

  describe("POST /v1/map", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL)
        .post("/v1/map")
        .send({ url: "https://firecrawl.dev" });
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key",
      async () => {
        const mapRequest = {
          url: "https://roastmywebsite.ai",
        };

        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(mapRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success", true);
        expect(response.body).toHaveProperty("links");
        if (!("links" in response.body)) {
          throw new Error("Expected response body to have 'links' property");
        }
        const links = response.body.links as unknown[];
        expect(Array.isArray(links)).toBe(true);
        expect(links.length).toBeGreaterThan(0);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key and search",
      async () => {
        const mapRequest = {
          url: "https://usemotion.com",
          search: "pricing",
        };

        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(mapRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success", true);
        expect(response.body).toHaveProperty("links");
        if (!("links" in response.body)) {
          throw new Error("Expected response body to have 'links' property");
        }
        const links = response.body.links as unknown[];
        expect(Array.isArray(links)).toBe(true);
        expect(links.length).toBeGreaterThan(0);
        expect(links[0]).toContain("usemotion.com/pricing");
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key and search and allowSubdomains",
      async () => {
        const mapRequest = {
          url: "https://firecrawl.dev",
          search: "docs",
          includeSubdomains: true,
        };

        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(mapRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success", true);
        expect(response.body).toHaveProperty("links");
        if (!("links" in response.body)) {
          throw new Error("Expected response body to have 'links' property");
        }
        const links = response.body.links as unknown[];
        expect(Array.isArray(links)).toBe(true);
        expect(links.length).toBeGreaterThan(0);

        const containsDocsFirecrawlDev = links.some((link: string) =>
          link.includes("docs.firecrawl.dev"),
        );
        expect(containsDocsFirecrawlDev).toBe(true);
      },
    );

    it.concurrent(
      "should return a successful response with a valid API key and search and allowSubdomains and www",
      async () => {
        const mapRequest = {
          url: "https://www.firecrawl.dev",
          search: "docs",
          includeSubdomains: true,
        };

        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(mapRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success", true);
        expect(response.body).toHaveProperty("links");
        if (!("links" in response.body)) {
          throw new Error("Expected response body to have 'links' property");
        }
        const links = response.body.links as unknown[];
        expect(Array.isArray(links)).toBe(true);
        expect(links.length).toBeGreaterThan(0);

        const containsDocsFirecrawlDev = links.some((link: string) =>
          link.includes("docs.firecrawl.dev"),
        );
        expect(containsDocsFirecrawlDev).toBe(true);
      },
      10000,
    );

    it.concurrent(
      "should return a successful response with a valid API key and search and not allowSubdomains and www",
      async () => {
        const mapRequest = {
          url: "https://www.firecrawl.dev",
          search: "docs",
          includeSubdomains: false,
        };

        const response: any = await request(TEST_URL)
          .post("/v1/map")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send(mapRequest);

        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("success", true);
        expect(response.body).toHaveProperty("links");
        if (!("links" in response.body)) {
          throw new Error("Expected response body to have 'links' property");
        }
        const links = response.body.links as unknown[];
        expect(Array.isArray(links)).toBe(true);
        expect(links.length).toBeGreaterThan(0);
        expect(links[0]).not.toContain("docs.firecrawl.dev");
      },
    );

    it.concurrent("should return an error for invalid URL", async () => {
      const mapRequest = {
        url: "invalid-url",
        includeSubdomains: true,
        search: "test",
      };

      const response: any = await request(TEST_URL)
        .post("/v1/map")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(mapRequest);

      expect(response.statusCode).toBe(400);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });
  });

  describe("POST /v1/crawl", () => {
    it.concurrent("should require authorization", async () => {
      const response: any = await request(TEST_URL)
        .post("/v1/crawl")
        .send({ url: "https://firecrawl.dev" });
      expect(response.statusCode).toBe(401);
    });

    it.concurrent("should throw error for blocklisted URL", async () => {
      const scrapeRequest: ScrapeRequestInput = {
        url: "https://facebook.com/fake-test",
      };

      const response = await request(TEST_URL)
        .post("/v1/crawl")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(403);
      expect(response.body.error).toBe(BLOCKLISTED_URL_MESSAGE);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response: any = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer invalid-api-key`)
          .set("Content-Type", "application/json")
          .send({ url: "https://firecrawl.dev" });
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent("should return a successful response", async () => {
      const response = await request(TEST_URL)
        .post("/v1/crawl")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://firecrawl.dev" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("id");
      expect(response.body.id).toMatch(
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
      );
      expect(response.body).toHaveProperty("success", true);
      expect(response.body).toHaveProperty("url");
      expect(response.body.url).toContain("/v1/crawl/");
    });

    it.concurrent(
      "should return a successful response with a valid API key and valid includes option",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://firecrawl.dev",
            limit: 40,
            includePaths: ["blog/*"],
          });

        let response;
        let isFinished = false;

        while (!isFinished) {
          response = await request(TEST_URL)
            .get(`/v1/crawl/${crawlResponse.body.id}`)
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
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(5);
        urls.forEach((url: string) => {
          expect(url).toContain("firecrawl.dev/blog");
        });

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0]).not.toHaveProperty("content"); // v0
        expect(completedResponse.body.data[0].metadata.statusCode).toBe(200);
        expect(completedResponse.body.data[0].metadata.error).toBeUndefined();
      },
      180000,
    ); // 180 seconds

    it.concurrent(
      "should return a successful response with a valid API key and valid excludes option",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://firecrawl.dev",
            limit: 40,
            excludePaths: ["blog/*"],
          });

        let isFinished = false;
        let response;

        while (!isFinished) {
          response = await request(TEST_URL)
            .get(`/v1/crawl/${crawlResponse.body.id}`)
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
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        const urls = completedResponse.body.data.map(
          (item: any) => item.metadata?.sourceURL,
        );
        expect(urls.length).toBeGreaterThan(3);
        urls.forEach((url: string) => {
          expect(url.startsWith("https://www.firecrawl.dev/blog/")).toBeFalsy();
        });
      },
      90000,
    ); // 90 seconds

    it.concurrent(
      "should return a successful response with max depth option for a valid crawl job",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({
            url: "https://www.scrapethissite.com",
            maxDepth: 1,
          });
        expect(crawlResponse.statusCode).toBe(200);

        const response = await request(TEST_URL)
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).toHaveProperty("status");
        expect(["active", "waiting", "completed", "scraping"]).toContain(
          response.body.status,
        );
        // wait for 60 seconds
        let isCompleted = false;
        while (!isCompleted) {
          const statusCheckResponse = await request(TEST_URL)
            .get(`/v1/crawl/${crawlResponse.body.id}`)
            .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
          expect(statusCheckResponse.statusCode).toBe(200);
          isCompleted = statusCheckResponse.body.status === "completed";
          if (!isCompleted) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }
        const completedResponse = await request(TEST_URL)
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).not.toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.statusCode).toBe(200);
        expect(completedResponse.body.data[0].metadata.error).toBeUndefined();
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

  describe("GET /v1/crawl/:jobId", () => {
    it.concurrent("should require authorization", async () => {
      const response = await request(TEST_URL).get("/v1/crawl/123");
      expect(response.statusCode).toBe(401);
    });

    it.concurrent(
      "should return an error response with an invalid API key",
      async () => {
        const response = await request(TEST_URL)
          .get("/v1/crawl/123")
          .set("Authorization", `Bearer invalid-api-key`);
        expect(response.statusCode).toBe(401);
      },
    );

    it.concurrent(
      "should return Job not found for invalid job ID",
      async () => {
        const response = await request(TEST_URL)
          .get("/v1/crawl/invalidJobId")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(response.statusCode).toBe(404);
      },
    );

    it.concurrent(
      "should return a successful crawl status response for a valid crawl job",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://docs.firecrawl.dev" });
        expect(crawlResponse.statusCode).toBe(200);

        let isCompleted = false;

        while (!isCompleted) {
          const response = await request(TEST_URL)
            .get(`/v1/crawl/${crawlResponse.body.id}`)
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
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("completed");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).not.toHaveProperty("content");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.statusCode).toBe(200);
        expect(completedResponse.body.data[0].metadata.error).toBeUndefined();

        const childrenLinks = completedResponse.body.data.filter(
          doc => doc.metadata && doc.metadata.sourceURL,
        );

        expect(childrenLinks.length).toBe(completedResponse.body.data.length);
      },
      180000,
    ); // 120 seconds

    it.concurrent(
      "If someone cancels a crawl job, it should turn into failed status",
      async () => {
        const crawlResponse = await request(TEST_URL)
          .post("/v1/crawl")
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
          .set("Content-Type", "application/json")
          .send({ url: "https://docs.firecrawl.dev", limit: 10 });

        expect(crawlResponse.statusCode).toBe(200);

        await new Promise(r => setTimeout(r, 10000));

        const responseCancel = await request(TEST_URL)
          .delete(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);
        expect(responseCancel.statusCode).toBe(200);
        expect(responseCancel.body).toHaveProperty("status");
        expect(responseCancel.body.status).toBe("cancelled");

        await new Promise(r => setTimeout(r, 10000));
        const completedResponse = await request(TEST_URL)
          .get(`/v1/crawl/${crawlResponse.body.id}`)
          .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`);

        expect(completedResponse.statusCode).toBe(200);
        expect(completedResponse.body).toHaveProperty("status");
        expect(completedResponse.body.status).toBe("cancelled");
        expect(completedResponse.body).toHaveProperty("data");
        expect(completedResponse.body.data[0]).toHaveProperty("markdown");
        expect(completedResponse.body.data[0]).toHaveProperty("metadata");
        expect(completedResponse.body.data[0].metadata.statusCode).toBe(200);
        expect(completedResponse.body.data[0].metadata.error).toBeUndefined();
      },
      60000,
    ); // 60 seconds
  });
});
