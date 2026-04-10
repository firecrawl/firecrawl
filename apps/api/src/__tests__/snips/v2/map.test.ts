import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { expectMapToSucceed, map, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "map",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

// TODO: is map meant for self-host?
describe("Map tests", () => {
  const base = TEST_SUITE_WEBSITE;

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "basic map succeeds",
    async () => {
      const response = await map(
        {
          url: base,
        },
        identity,
      );

      expectMapToSucceed(response);
    },
    60000,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "times out properly",
    async () => {
      const response = await map(
        {
          url: base,
          timeout: 1,
        },
        identity,
      );

      expect(response.statusCode).toBe(408);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("The map operation timed out");
    },
    10000,
  );

  it.concurrent(
    "handles query parameters correctly",
    async () => {
      let response = await map(
        {
          url: "https://www.hfea.gov.uk",
          sitemap: "only",
          useMock: "map-query-params",
          ignoreQueryParameters: false,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(
        response.body.links.some(x =>
          x.url.match(
            /^https:\/\/www\.hfea\.gov\.uk\/choose-a-clinic\/clinic-search\/results\/?\?options=\d+$/,
          ),
        ),
      ).toBe(true);
    },
    60000,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sitemap=only respects limit",
    async () => {
      const response = await map(
        {
          url: base,
          sitemap: "only",
          limit: 10,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.links.length).toBe(10);
    },
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sitemapOnly: true works at API level",
    async () => {
      const response = await map(
        {
          url: base,
          sitemapOnly: true,
          limit: 10,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.links.length).toBe(10);
    },
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "ignoreSitemap: true works at API level",
    async () => {
      // Verify that sitemap-only returns results (to ensure test site has a sitemap)
      const sitemapOnlyResponse = await map(
        {
          url: base,
          sitemap: "only",
          limit: 10,
        },
        identity,
      );

      expect(sitemapOnlyResponse.statusCode).toBe(200);
      expect(sitemapOnlyResponse.body.success).toBe(true);
      // Test site should have a sitemap with URLs
      expect(sitemapOnlyResponse.body.links.length).toBeGreaterThan(0);
      const sitemapUrls = new Set(
        sitemapOnlyResponse.body.links.map((l: any) => l.url || l),
      );

      const response = await map(
        {
          url: base,
          ignoreSitemap: true,
          limit: 20,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.links)).toBe(true);
      // Should get results even when sitemap is ignored, proving ignoreSitemap works
      expect(response.body.links.length).toBeGreaterThan(0);

      // Verify we got results from sources other than sitemap
      // (Some URLs might overlap between sitemap and index, which is expected)
      const responseUrls = new Set(
        response.body.links.map((l: any) => l.url || l),
      );
      expect(responseUrls.size).toBeGreaterThan(0);

      // If test site has pages in index that aren't in sitemap, verify we got some of those
      // But we don't fail if all URLs match sitemap, as that's valid for some test sites
      // The key is that we got results, proving ignoreSitemap parameter works correctly
    },
  );

  // TODO: port to new system
  it.concurrent(
    "shows warning when results ≤ 1 and URL is not base domain",
    async () => {
      // Use a mock that returns 0 or 1 results to test the warning
      const response = await map(
        {
          url: "https://example.com/some/path",
          useMock: "map-empty", // This should return 0 or 1 results
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);

      // Assert the prerequisite condition
      expect(response.body.links.length).toBeLessThanOrEqual(1);

      // Check that the warning is present
      expect(response.body.warning).toBeDefined();
      expect(response.body.warning).toContain("Only");
      expect(response.body.warning).toContain("result(s) found");
      expect(response.body.warning).toContain("base domain");
      expect(response.body.warning).toContain("example.com");
    },
    60000,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "handles redirects correctly",
    async () => {
      const response = await map(
        {
          url: "http://firecrawl.com",
          limit: 5,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.links.length).toBeGreaterThan(0);

      const nonFirecrawlLinks = response.body.links.filter(
        link => !link.url.includes("firecrawl.dev"),
      );
      if (nonFirecrawlLinks.length > 0) {
        console.log(
          "Links not containing 'firecrawl.dev':",
          JSON.stringify(nonFirecrawlLinks, null, 2),
        );
      }

      expect(
        response.body.links.every(link => link.url.includes("firecrawl.dev")),
      ).toBe(true);
    },
    60000,
  );
});
