import { z } from "zod";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import type { Identity } from "./lib";
import { scrape, scrapeTimeout, idmux, scrapeRaw } from "./lib";

const changeTrackingResponseSchema = z.object({
  changeTracking: z.unknown().optional(),
});

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-formats",
    concurrency: 100,
    credits: 1_000_000,
  });
}, 10_000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("Scrape format variations", () => {
  const base = TEST_SUITE_WEBSITE;

  describe("String format inputs", () => {
    it.concurrent(
      "accepts string format for markdown",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [{ type: "markdown" }],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(typeof response.markdown).toBe("string");
        expect(response.markdown?.length).toBeGreaterThan(0);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "accepts multiple string formats",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: ["markdown", "html", "links"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.html).toBeDefined();
        expect(response.links).toBeDefined();
        expect(Array.isArray(response.links)).toBe(true);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION)(
      "accepts string format for screenshot",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: ["screenshot"],
          },
          identity,
        );

        expect(response.screenshot).toBeDefined();
        expect(typeof response.screenshot).toBe("string");
      },
      scrapeTimeout,
    );
  });

  describe("Object format inputs", () => {
    it.concurrent(
      "accepts object format for markdown",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [{ type: "markdown" }],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(typeof response.markdown).toBe("string");
        expect(response.markdown?.length).toBeGreaterThan(0);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "accepts multiple object formats",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              { type: "markdown" },
              { type: "html" },
              { type: "links" },
            ],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.html).toBeDefined();
        expect(response.links).toBeDefined();
        expect(Array.isArray(response.links)).toBe(true);
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION)(
      "accepts object format for screenshot with options",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              {
                type: "screenshot",
                fullPage: true,
                quality: 80,
                viewport: { width: 1920, height: 1080 },
              },
            ],
          },
          identity,
        );

        expect(response.screenshot).toBeDefined();
        expect(typeof response.screenshot).toBe("string");
      },
      scrapeTimeout,
    );
  });

  describe("Mixed format inputs", () => {
    it.concurrent(
      "accepts mixed string and object formats",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: ["markdown", { type: "html" }, "links"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.html).toBeDefined();
        expect(response.links).toBeDefined();
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION)(
      "handles complex formats alongside simple ones",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              "markdown",
              {
                type: "screenshot",
                fullPage: false,
                quality: 90,
              },
              { type: "links" },
            ],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.screenshot).toBeDefined();
        expect(response.links).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("Format with options that already exist", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "handles json format with schema",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              {
                type: "json",
                prompt: "Extract the main heading and description",
                schema: {
                  type: "object",
                  properties: {
                    heading: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            ],
          },
          identity,
        );

        expect(response.json).toBeDefined();
        expect(typeof response.json).toBe("object");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION)(
      "handles changeTracking format with options",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              "markdown",
              {
                type: "changeTracking",
                modes: ["json"],
                tag: "test-tag",
              },
            ],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        const parsedChangeTracking =
          changeTrackingResponseSchema.safeParse(response);
        expect(
          parsedChangeTracking.success
            ? parsedChangeTracking.data.changeTracking
            : undefined,
        ).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("Edge cases and validation", () => {
    it.concurrent(
      "default format is markdown when formats not specified",
      async () => {
        const response = await scrape(
          {
            url: base,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(typeof response.markdown).toBe("string");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects invalid format type in object",
      async () => {
        const raw = await scrapeRaw(
          {
            url: base,
            formats: [{ type: "invalid-format" }],
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "maintains backward compatibility with string-only formats",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: ["markdown", "html", "rawHtml", "links"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.html).toBeDefined();
        expect(response.rawHtml).toBeDefined();
        expect(response.links).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("Format type consistency in output", () => {
    it.concurrent(
      "string input produces consistent output structure",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: ["markdown", "html"],
          },
          identity,
        );

        const keys = Object.keys(response);
        expect(keys).toContain("markdown");
        expect(keys).toContain("html");
        expect(keys).toContain("metadata");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "object input produces identical output structure",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [{ type: "markdown" }, { type: "html" }],
          },
          identity,
        );

        const keys = Object.keys(response);
        expect(keys).toContain("markdown");
        expect(keys).toContain("html");
        expect(keys).toContain("metadata");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "mixed input produces consistent output",
      async () => {
        const response1 = await scrape(
          {
            url: base,
            formats: ["markdown", "html"],
          },
          identity,
        );

        const response2 = await scrape(
          {
            url: base,
            formats: [{ type: "markdown" }, { type: "html" }],
          },
          identity,
        );

        const response3 = await scrape(
          {
            url: base,
            formats: ["markdown", { type: "html" }],
          },
          identity,
        );

        expect(Object.keys(response1).sort()).toEqual(
          Object.keys(response2).sort(),
        );
        expect(Object.keys(response2).sort()).toEqual(
          Object.keys(response3).sort(),
        );
      },
      scrapeTimeout,
    );
  });
});
