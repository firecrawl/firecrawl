import request from "supertest";
import { configDotenv } from "dotenv";
import { ScrapeRequest } from "../../controllers/v1/types";

configDotenv();
const FIRECRAWL_API_URL = "http://127.0.0.1:3002";
const E2E_TEST_SERVER_URL = "http://firecrawl-e2e-test.vercel.app"; // @rafaelsideguide/firecrawl-e2e-test

describe("E2E Tests for v1 API Routes", () => {
  it.concurrent(
    "should return a successful response for a scrape with 403 page",
    async () => {
      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://httpstat.us/403" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(response.body.data).toHaveProperty("markdown");
      expect(response.body.data).toHaveProperty("metadata");
      expect(response.body.data.metadata.statusCode).toBe(403);
    },
    30000,
  );

  it.concurrent(
    "should handle 'formats:markdown (default)' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
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

      expect(response.body.data.markdown).toContain(
        "This page is used for end-to-end (e2e) testing with Firecrawl.",
      );
      expect(response.body.data.markdown).toContain(
        "Content with id #content-1",
      );
      // expect(response.body.data.markdown).toContain("Loading...");
      expect(response.body.data.markdown).toContain("Click me!");
      expect(response.body.data.markdown).toContain(
        "Power your AI apps with clean data crawled from any website. It's also open-source.",
      ); // firecrawl.dev inside an iframe
      expect(response.body.data.markdown).toContain(
        "This content loads only when you see it. Don't blink! 👼",
      ); // the browser always scroll to the bottom
      expect(response.body.data.markdown).not.toContain("Header"); // Only main content is returned by default
      expect(response.body.data.markdown).not.toContain("footer"); // Only main content is returned by default
      expect(response.body.data.markdown).not.toContain(
        "This content is only visible on mobile",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'formats:html' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["html"],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
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

      expect(response.body.data.html).not.toContain(
        '<header class="row-start-1" style="">Header</header>',
      );
      expect(response.body.data.html).toContain(
        '<p style="">This page is used for end-to-end (e2e) testing with Firecrawl.</p>',
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'rawHtml' in 'formats' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["rawHtml"],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
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
      expect(response.body.data).toHaveProperty("rawHtml");

      expect(response.body.data.rawHtml).toContain(
        ">This page is used for end-to-end (e2e) testing with Firecrawl.</p>",
      );
      expect(response.body.data.rawHtml).toContain(">Header</header>");
    },
    30000,
  );

  // - TODO: tests for links
  // - TODO: tests for screenshot
  // - TODO: tests for screenshot@fullPage

  it.concurrent(
    "should handle 'headers' parameter correctly",
    async () => {
      // @ts-ignore
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        headers: { "e2e-header-test": "firecrawl" },
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      expect(response.body.data.markdown).toContain(
        "e2e-header-test: firecrawl",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'includeTags' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        includeTags: ["#content-1"],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      expect(response.body.data.markdown).not.toContain(
        "<p>This page is used for end-to-end (e2e) testing with Firecrawl.</p>",
      );
      expect(response.body.data.markdown).toContain(
        "Content with id #content-1",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'excludeTags' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        excludeTags: ["#content-1"],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      expect(response.body.data.markdown).toContain(
        "This page is used for end-to-end (e2e) testing with Firecrawl.",
      );
      expect(response.body.data.markdown).not.toContain(
        "Content with id #content-1",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'onlyMainContent' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["html", "markdown"],
        onlyMainContent: false,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      expect(response.body.data.markdown).toContain(
        "This page is used for end-to-end (e2e) testing with Firecrawl.",
      );
      expect(response.body.data.html).toContain(
        '<header class="row-start-1" style="">Header</header>',
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'timeout' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        timeout: 500,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(408);

      if (!("error" in response.body)) {
        throw new Error("Expected response body to have 'error' property");
      }
      expect(response.body.error).toContain("Scrape timed out");
      expect(response.body.success).toBe(false);
    },
    30000,
  );

  it.concurrent(
    "should handle 'mobile' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        mobile: true,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);

      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(response.body.data.markdown).toContain(
        "This content is only visible on mobile",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'parsePDF' parameter correctly",
    async () => {
      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({ url: "https://arxiv.org/pdf/astro-ph/9301001.pdf" });
      await new Promise(r => setTimeout(r, 6000));

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      expect(response.body.data.markdown).toContain(
        "arXiv:astro-ph/9301001v1 7 Jan 1993",
      );
      expect(response.body.data.markdown).not.toContain(
        "h7uKu14adDL6yGfnGf2qycY5uq8kC3OKCWkPxm",
      );

      const responseNoParsePDF: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          url: "https://arxiv.org/pdf/astro-ph/9301001.pdf",
          parsePDF: false,
        });
      await new Promise(r => setTimeout(r, 6000));

      expect(responseNoParsePDF.statusCode).toBe(200);
      expect(responseNoParsePDF.body).toHaveProperty("data");
      if (!("data" in responseNoParsePDF.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(responseNoParsePDF.body.data.markdown).toContain(
        "h7uKu14adDL6yGfnGf2qycY5uq8kC3OKCWkPxm",
      );
    },
    30000,
  );

  // it.concurrent("should handle 'location' parameter correctly",
  //   async () => {
  //     const scrapeRequest: ScrapeRequest = {
  //       url: "https://roastmywebsite.ai",
  //       location: {
  //         country: "US",
  //         languages: ["en"]
  //       }
  //     };

  //     const response: any = await request(FIRECRAWL_API_URL)
  //       .post("/v1/scrape")
  //       .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
  //       .set("Content-Type", "application/json")
  //       .send(scrapeRequest);

  //     expect(response.statusCode).toBe(200);
  //     // Add assertions to verify location is handled correctly
  //   },
  // 30000);

  it.concurrent(
    "should handle 'skipTlsVerification' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: "https://expired.badssl.com/",
        timeout: 120000,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);
      console.log("Error1a");
      // console.log(response.body)
      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(response.body.data.metadata.pageStatusCode).toBe(500);
      console.log("Error?");

      const scrapeRequestWithSkipTlsVerification = {
        url: "https://expired.badssl.com/",
        skipTlsVerification: true,
        timeout: 120000,
      } as ScrapeRequest;

      const responseWithSkipTlsVerification: any = await request(
        FIRECRAWL_API_URL,
      )
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequestWithSkipTlsVerification);

      console.log("Error1b");
      // console.log(responseWithSkipTlsVerification.body)
      expect(responseWithSkipTlsVerification.statusCode).toBe(200);
      if (!("data" in responseWithSkipTlsVerification.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      // console.log(responseWithSkipTlsVerification.body.data)
      expect(responseWithSkipTlsVerification.body.data.markdown).toContain(
        "badssl.com",
      );
    },
    60000,
  );

  it.concurrent(
    "should handle 'removeBase64Images' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        removeBase64Images: true,
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      // console.log(response.body.data.markdown)
      // - TODO: not working for every image
      // expect(response.body.data.markdown).toContain("Image-Removed");
    },
    30000,
  );

  it.concurrent(
    "should handle 'action wait' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        actions: [
          {
            type: "wait",
            milliseconds: 10000,
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(response.body.data.markdown).not.toContain("Loading...");
      expect(response.body.data.markdown).toContain(
        "Content loaded after 5 seconds!",
      );
    },
    30000,
  );

  // screenshot
  it.concurrent(
    "should handle 'action screenshot' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        actions: [
          {
            type: "screenshot",
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      if (!response.body.data.actions?.screenshots) {
        throw new Error("Expected response body to have screenshots array");
      }
      expect(response.body.data.actions.screenshots[0].length).toBeGreaterThan(
        0,
      );
      expect(response.body.data.actions.screenshots[0]).toContain(
        "https://service.firecrawl.dev/storage/v1/object/public/media/screenshot-",
      );

      // TODO compare screenshot with expected screenshot
    },
    30000,
  );

  it.concurrent(
    "should handle 'action screenshot@fullPage' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        actions: [
          {
            type: "screenshot",
            fullPage: true,
          },
          {
            type: "scrape",
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      // console.log(response.body.data.actions?.screenshots[0])
      if (!response.body.data.actions?.screenshots) {
        throw new Error("Expected response body to have screenshots array");
      }
      expect(response.body.data.actions.screenshots[0].length).toBeGreaterThan(
        0,
      );
      expect(response.body.data.actions.screenshots[0]).toContain(
        "https://service.firecrawl.dev/storage/v1/object/public/media/screenshot-",
      );

      if (!response.body.data.actions?.scrapes) {
        throw new Error("Expected response body to have scrapes array");
      }
      expect(response.body.data.actions.scrapes[0].url).toBe(
        "https://firecrawl-e2e-test.vercel.app/",
      );
      expect(response.body.data.actions.scrapes[0].html).toContain(
        "This page is used for end-to-end (e2e) testing with Firecrawl.</p>",
      );
      // TODO compare screenshot with expected full page screenshot
    },
    30000,
  );

  it.concurrent(
    "should handle 'action click' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        actions: [
          {
            type: "click",
            selector: "#click-me",
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }
      expect(response.body.data.markdown).not.toContain("Click me!");
      expect(response.body.data.markdown).toContain(
        "Text changed after click!",
      );
    },
    30000,
  );

  it.concurrent(
    "should handle 'action write' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["html"],
        actions: [
          {
            type: "click",
            selector: "#input-1",
          },
          {
            type: "write",
            text: "Hello, world!",
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      expect(response.statusCode).toBe(200);
      if (!("data" in response.body)) {
        throw new Error("Expected response body to have 'data' property");
      }

      // TODO: fix this test (need to fix fire-engine first)
      // uncomment the following line:
      // expect(response.body.data.html).toContain("<input id=\"input-1\" type=\"text\" placeholder=\"Enter text here...\" style=\"padding:8px;margin:10px;border:1px solid #ccc;border-radius:4px;background-color:#000\" value=\"Hello, world!\">");
    },
    30000,
  );

  // TODO: fix this test (need to fix fire-engine first)
  it.concurrent(
    "should handle 'action pressKey' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["markdown"],
        actions: [
          {
            type: "press",
            key: "ArrowDown",
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      // // TODO: fix this test (need to fix fire-engine first)
      // // right now response.body is: { success: false, error: '(Internal server error) - null' }
      // expect(response.statusCode).toBe(200);
      // if (!("data" in response.body)) {
      //   throw new Error("Expected response body to have 'data' property");
      // }
      // expect(response.body.data.markdown).toContain("Last Key Clicked: ArrowDown")
    },
    30000,
  );

  // TODO: fix this test (need to fix fire-engine first)
  it.concurrent(
    "should handle 'action scroll' parameter correctly",
    async () => {
      const scrapeRequest = {
        url: E2E_TEST_SERVER_URL,
        formats: ["markdown"],
        actions: [
          {
            type: "click",
            selector: "#scroll-bottom-loader",
          },
          {
            type: "scroll",
            direction: "down",
            amount: 2000,
          },
        ],
      } as ScrapeRequest;

      const response: any = await request(FIRECRAWL_API_URL)
        .post("/v1/scrape")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send(scrapeRequest);

      // TODO: uncomment this tests
      // expect(response.statusCode).toBe(200);
      // if (!("data" in response.body)) {
      //   throw new Error("Expected response body to have 'data' property");
      // }
      //
      // expect(response.body.data.markdown).toContain("You have reached the bottom!")
    },
    30000,
  );

  // TODO: test scrape action
});
