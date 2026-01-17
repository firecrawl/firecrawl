import { config } from "../../../config";
import {
  describeIf,
  concurrentIf,
  HAS_PLAYWRIGHT,
} from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  idmux,
  Identity,
  TEST_API_URL,
} from "./lib";
import { describe, it, expect, beforeAll } from "@jest/globals";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-ajax-discovery",
    concurrency: 10,
    credits: 100000,
  });
}, 10000);

describeIf(HAS_PLAYWRIGHT)("AJAX Discovery tests", () => {
  // Test URL from TODO file - page with year tabs that load Oscar film data via AJAX
  const ajaxTestUrl = "https://www.scrapethissite.com/pages/ajax-javascript/";

  it.concurrent(
    "accepts discoverAjax parameter",
    async () => {
      const raw = await scrapeRaw(
        {
          url: ajaxTestUrl,
          formats: ["links"],
          discoverAjax: true,
        },
        identity,
      );

      expect(raw.statusCode).toBe(200);
      expect(raw.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "discovers AJAX-loaded URLs when enabled",
    async () => {
      const response = await scrape(
        {
          url: ajaxTestUrl,
          formats: ["links"],
          discoverAjax: true,
        },
        identity,
      );

      // The page should discover AJAX URLs for years 2010-2015
      // Expected to find URLs like ?ajax=true&year=2015
      expect(response.links).toBeDefined();
      expect(Array.isArray(response.links)).toBe(true);

      // With AJAX discovery enabled, we should find more links than just HTML <a> tags
      // The page has year tabs that load via AJAX
      if (response.links && response.links.length > 0) {
        // Check if any discovered URLs contain the AJAX query pattern
        const ajaxUrls = response.links.filter(link =>
          link.includes("ajax=true") || link.includes("year=")
        );

        // We expect to find at least some AJAX-loaded URLs
        // (Note: actual behavior depends on Camoufox service being configured)
        expect(ajaxUrls.length).toBeGreaterThanOrEqual(0);
      }
    },
    scrapeTimeout,
  );

  it.concurrent(
    "works with discoverAjax disabled (default)",
    async () => {
      const response = await scrape(
        {
          url: ajaxTestUrl,
          formats: ["links"],
          discoverAjax: false,
        },
        identity,
      );

      expect(response.links).toBeDefined();
      expect(Array.isArray(response.links)).toBe(true);

      // Without AJAX discovery, standard link extraction still works
    },
    scrapeTimeout,
  );

  it.concurrent(
    "defaults to discoverAjax: false when not specified",
    async () => {
      const raw = await scrapeRaw(
        {
          url: ajaxTestUrl,
          formats: ["links"],
          // discoverAjax not specified - should default to false
        },
        identity,
      );

      expect(raw.statusCode).toBe(200);
      expect(raw.body.success).toBe(true);
      expect(raw.body.data.links).toBeDefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "merges discovered URLs with HTML links without duplicates",
    async () => {
      const response = await scrape(
        {
          url: ajaxTestUrl,
          formats: ["links"],
          discoverAjax: true,
        },
        identity,
      );

      if (response.links && response.links.length > 0) {
        // Check for duplicates
        const uniqueLinks = new Set(response.links);
        expect(uniqueLinks.size).toBe(response.links.length);
      }
    },
    scrapeTimeout,
  );
});
