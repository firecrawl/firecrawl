import request from "supertest";
import dotenv from "dotenv";
import {
  FirecrawlCrawlResponse,
  FirecrawlCrawlStatusResponse,
  FirecrawlScrapeResponse,
} from "../../types";

dotenv.config();
const TEST_URL = "http://127.0.0.1:3002";

describe("E2E Tests for Extract API Routes", () => {
  it.concurrent(
    "should return authors of blog posts on firecrawl.dev",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["https://firecrawl.dev/*"],
          prompt: "Who are the authors of the blog posts?",
          schema: {
            type: "object",
            properties: {
              authors: { type: "array", items: { type: "string" } },
            },
          },
        });

      console.log(response.body);
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("authors");

      let gotItRight = 0;
      for (const author of response.body.data?.authors) {
        if (author.includes("Caleb Peffer")) gotItRight++;
        if (author.includes("Gergő Móricz")) gotItRight++;
        if (author.includes("Eric Ciarla")) gotItRight++;
        if (author.includes("Nicolas Camara")) gotItRight++;
        if (author.includes("Jon")) gotItRight++;
        if (author.includes("Wendong")) gotItRight++;
      }

      expect(gotItRight).toBeGreaterThan(1);
    },
    60000,
  );

  it.concurrent(
    "should return founders of firecrawl.dev (allowExternalLinks = true)",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["firecrawl.dev/*"],
          prompt: "Who are the founders of the company?",
          allowExternalLinks: true,
          schema: {
            type: "object",
            properties: {
              founders: { type: "array", items: { type: "string" } },
            },
          },
        });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("founders");

      console.log(response.body.data?.founders);
      let gotItRight = 0;
      for (const founder of response.body.data?.founders) {
        if (founder.includes("Caleb")) gotItRight++;
        if (founder.includes("Eric")) gotItRight++;
        if (founder.includes("Nicolas")) gotItRight++;
        if (founder.includes("nick")) gotItRight++;
        if (founder.includes("eric")) gotItRight++;
        if (founder.includes("jon-noronha")) gotItRight++;
      }

      expect(gotItRight).toBeGreaterThanOrEqual(2);
    },
    60000,
  );

  it.concurrent(
    "should return hiring opportunities on firecrawl.dev (allowExternalLinks = true)",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["https://firecrawl.dev/*"],
          prompt: "What are they hiring for?",
          allowExternalLinks: true,
          schema: {
            type: "array",
            items: {
              type: "string",
            },
            required: ["items"],
          },
        });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      console.log(response.body.data);

      let gotItRight = 0;
      for (const hiring of response.body.data?.items) {
        if (hiring.includes("Firecrawl Example Creator")) gotItRight++;
        if (hiring.includes("Senior Frontend Engineer")) gotItRight++;
        if (hiring.includes("Technical Chief of Staff")) gotItRight++;
        if (hiring.includes("Founding Web Automation Engineer")) gotItRight++;
        if (hiring.includes("Founding Fullstack Engineer")) gotItRight++;
      }

      expect(gotItRight).toBeGreaterThan(2);
    },
    60000,
  );

  it.concurrent(
    "should return PCI DSS compliance for Fivetran",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["fivetran.com/*"],
          prompt: "Does Fivetran have PCI DSS compliance?",
          allowExternalLinks: true,
          schema: {
            type: "object",
            properties: {
              pciDssCompliance: { type: "boolean" },
            },
          },
        });
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data?.pciDssCompliance).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "should return Azure Data Connectors for Fivetran",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["fivetran.com/*"],
          prompt: "What are the Azure Data Connectors they offer?",
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                connector: { type: "string" },
                description: { type: "string" },
                supportsCaptureDelete: { type: "boolean" },
              },
            },
          },
        });

      console.log(response.body);
      // expect(response.statusCode).toBe(200);
      // expect(response.body).toHaveProperty("data");
      // expect(response.body.data?.pciDssCompliance).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "should return Greenhouse Applicant Tracking System for Abnormal Security",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: [
            "https://careers.abnormalsecurity.com/jobs/6119456003?gh_jid=6119456003",
          ],
          prompt: "what applicant tracking system is this company using?",
          schema: {
            type: "object",
            properties: {
              isGreenhouseATS: { type: "boolean" },
              answer: { type: "string" },
            },
          },
          allowExternalLinks: true,
        });

      console.log(response.body);
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data?.isGreenhouseATS).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "should return mintlify api components",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["https://mintlify.com/docs/*"],
          prompt: "what are the 4 API components?",
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                component: { type: "string" },
              },
            },
            required: ["items"],
          },
          allowExternalLinks: true,
        });

      console.log(response.body.data?.items);
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data?.items.length).toBe(4);
      let gotItRight = 0;
      for (const component of response.body.data?.items) {
        if (component.component.toLowerCase().includes("parameter"))
          gotItRight++;
        if (component.component.toLowerCase().includes("response"))
          gotItRight++;
        if (component.component.toLowerCase().includes("expandable"))
          gotItRight++;
        if (component.component.toLowerCase().includes("sticky")) gotItRight++;
        if (component.component.toLowerCase().includes("examples"))
          gotItRight++;
      }
      expect(gotItRight).toBeGreaterThan(2);
    },
    60000,
  );

  it.concurrent(
    "should return information about Eric Ciarla",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["https://ericciarla.com/"],
          prompt:
            "Who is Eric Ciarla? Where does he work? Where did he go to school?",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              work: { type: "string" },
              education: { type: "string" },
            },
            required: ["name", "work", "education"],
          },
          allowExternalLinks: true,
        });

      console.log(response.body.data);
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data?.name).toBe("Eric Ciarla");
      expect(response.body.data?.work).toBeDefined();
      expect(response.body.data?.education).toBeDefined();
    },
    60000,
  );

  it.concurrent(
    "should extract information without a schema",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: ["https://docs.firecrawl.dev"],
          prompt: "What is the title and description of the page?",
        });

      console.log(response.body.data);
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(typeof response.body.data).toBe("object");
      expect(Object.keys(response.body.data).length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "should extract information with scrapeOptions.waitFor",
    async () => {
      const response = await request(TEST_URL)
        .post("/v1/extract")
        .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
        .set("Content-Type", "application/json")
        .send({
          urls: [
            "https://firecrawl-e2e-test-git-main-rafaelsideguides-projects.vercel.app/",
          ],
          prompt: "What is the content right after the #content-1 id?",
          schema: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
            required: ["content"],
          },
          scrapeOptions: {
            waitFor: 6000,
          },
        });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveProperty("data");
      expect(typeof response.body.data).toBe("object");
      expect(response.body.data?.content).toBeDefined();
      expect(response.body.data?.content).toBe(
        "Content loaded after 5 seconds!",
      );
    },
    60000,
  );
});
