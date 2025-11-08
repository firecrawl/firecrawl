import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";
import { promises as fs } from "fs";
import os from "os";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parsers",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("Parsers parameter tests", () => {
  const pdfUrl = `${TEST_SUITE_WEBSITE}/example.pdf`;
  const htmlUrl = TEST_SUITE_WEBSITE;
  const fakePdfHtmlUrl = `${TEST_SUITE_WEBSITE}/not-a-pdf.pdf`;

  async function listTempFilesForScrape(scrapeId: string): Promise<string[]> {
    if (!scrapeId) {
      throw new Error("scrapeId is required to inspect temp files");
    }
    const files = await fs.readdir(os.tmpdir());
    return files.filter(file => file.startsWith(`tempFile-${scrapeId}`));
  }

  async function expectTempFilesCleaned(
    scrapeId: string,
    attempts = 5,
    delayMs = 300,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const leaked = await listTempFilesForScrape(scrapeId);
      if (leaked.length === 0) {
        return;
      }
      if (i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const leaked = await listTempFilesForScrape(scrapeId);
    expect(leaked).toEqual([]);
  }

  describe("Array format", () => {
    it.concurrent(
      "accepts parsers: ['pdf'] and parses PDF",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: ["pdf"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.numPages).toBeGreaterThan(0);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "accepts parsers: [] and returns PDF in base64",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("JVBER"); // base64
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "accepts parsers: ['pdf'] on HTML pages (no effect)",
      async () => {
        const response = await scrape(
          {
            url: htmlUrl,
            parsers: ["pdf"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("Firecrawl");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "accepts empty parsers array on HTML pages",
      async () => {
        const response = await scrape(
          {
            url: htmlUrl,
            parsers: [],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("Firecrawl");
      },
      scrapeTimeout,
    );
  });

  describe("Object format", () => {
    it.concurrent(
      "accepts parsers: [{type: 'pdf'}] and parses PDF",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf" }],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.numPages).toBeGreaterThan(0);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "accepts parsers: [{type: 'pdf', maxPages: 1}] and limits pages",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf", maxPages: 1 }],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.numPages).toBe(1);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "handles maxPages larger than actual pages",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf", maxPages: 10000 }],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.numPages).toBeGreaterThan(0);
        expect(response.metadata.numPages).toBeLessThan(10000);
      },
      scrapeTimeout * 2,
    );
  });

  describe("Default behavior", () => {
    it.concurrent(
      "parses PDF by default when parsers not specified",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.numPages).toBeGreaterThan(0);
      },
      scrapeTimeout * 2,
    );
  });

  describe("Invalid inputs", () => {
    it.concurrent(
      "rejects invalid parser types",
      async () => {
        const raw = await scrapeRaw(
          {
            url: pdfUrl,
            parsers: ["invalid-parser" as any],
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("Bad Request");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects non-array parsers",
      async () => {
        const raw = await scrapeRaw(
          {
            url: pdfUrl,
            parsers: "pdf" as any,
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("Bad Request");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects old object format",
      async () => {
        const raw = await scrapeRaw(
          {
            url: pdfUrl,
            parsers: { pdf: true } as any,
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("Bad Request");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects negative maxPages",
      async () => {
        const raw = await scrapeRaw(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf", maxPages: -1 }],
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("Bad Request");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects maxPages over limit",
      async () => {
        const raw = await scrapeRaw(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf", maxPages: 10001 }],
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("Bad Request");
      },
      scrapeTimeout,
    );
  });

  describe("Billing implications", () => {
    it.concurrent(
      "bills correctly with parsers: ['pdf']",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: ["pdf"],
          },
          identity,
        );

        // Should bill based on number of pages when PDF parsing is enabled
        expect(response.metadata.creditsUsed).toBeGreaterThanOrEqual(
          response.metadata.numPages || 1,
        );
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "bills flat rate with parsers: []",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [],
          },
          identity,
        );

        // Should bill flat rate (1 credit) when PDF parsing is disabled
        expect(response.metadata.creditsUsed).toBe(1);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "bills based on limited pages with maxPages",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: [{ type: "pdf", maxPages: 1 }],
          },
          identity,
        );

        // Should bill based on limited pages (1 page = 1 credit)
        expect(response.metadata.creditsUsed).toBe(1);
        expect(response.metadata.numPages).toBe(1);
      },
      scrapeTimeout * 2,
    );
  });

  describe("Temp file cleanup (memory leak regression)", () => {
    it.concurrent(
      "cleans up temp files after successful PDF parse",
      async () => {
        const response = await scrape(
          {
            url: pdfUrl,
            parsers: ["pdf"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown).toContain("PDF Test File");
        expect(response.metadata.scrapeId).toBeDefined();

        await expectTempFilesCleaned(response.metadata.scrapeId!);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "cleans up temp files after PDF parse failure (non-PDF content)",
      async () => {
        const response = await scrape(
          {
            url: fakePdfHtmlUrl,
            parsers: ["pdf"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.metadata.scrapeId).toBeDefined();

        await expectTempFilesCleaned(response.metadata.scrapeId!);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "cleans up temp files after multiple PDF operations",
      async () => {
        const scrapeIds: string[] = [];

        for (let i = 0; i < 3; i++) {
          const response = await scrape(
            {
              url: i === 1 ? fakePdfHtmlUrl : pdfUrl,
              parsers: ["pdf"],
            },
            identity,
          );
          expect(response.metadata.scrapeId).toBeDefined();
          scrapeIds.push(response.metadata.scrapeId!);
        }

        await Promise.all(
          scrapeIds.map(scrapeId => expectTempFilesCleaned(scrapeId, 8, 250)),
        );
      },
      scrapeTimeout * 6,
    );
  });
});
