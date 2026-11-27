import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import type { Identity } from "./lib";
import { expectMapToSucceed, getMapLinks, map, idmux } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "map",
    concurrency: 100,
    credits: 1_000_000,
  });
}, 10_000);

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
    60_000,
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
    10_000,
  );

  it.concurrent("handles query parameters correctly", async () => {
    const response = await map(
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
      getMapLinks(response).some(x =>
        x.url.match(
          /^https:\/\/www\.hfea\.gov\.uk\/choose-a-clinic\/clinic-search\/results\/?\?options=\d+$/,
        ),
      ),
    ).toBe(true);
  }, 60_000);

  it.concurrent("sitemap=only returns every URL of the sitemap", async () => {
    const payload: Parameters<typeof map>[0] = {
      url: "https://www.hfea.gov.uk",
      sitemap: "only",
      useMock: "map-sitemap-all-urls",
    };
    if (TEST_PRODUCTION) {
      payload.ignoreCache = true;
    }
    const response = await map(payload, identity);

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);

    // The first URL the sitemap yields used to be discarded, so
    // /first-page never made it into the response.
    const urls = getMapLinks(response).map(x => x.url);
    expect(urls).toContain("https://www.hfea.gov.uk/first-page");
    expect(urls).toContain("https://www.hfea.gov.uk/second-page");
    expect(urls).toContain("https://www.hfea.gov.uk/third-page");
  }, 60_000);

  it.concurrent("sitemap=only still respects a limit smaller than the sitemap", async () => {
    const payload: Parameters<typeof map>[0] = {
      url: "https://www.hfea.gov.uk",
      sitemap: "only",
      useMock: "map-sitemap-all-urls",
      limit: 2,
    };
    if (TEST_PRODUCTION) {
      payload.ignoreCache = true;
    }
    const response = await map(payload, identity);

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.links.length).toBe(2);
  }, 60_000);

  it.concurrent("sitemap=only skips a deeply nested sitemap and returns the others", async () => {
    const payload: Parameters<typeof map>[0] = {
      url: "https://www.hfea.gov.uk",
      sitemap: "only",
      useMock: "map-sitemap-deeply-nested",
    };
    if (TEST_PRODUCTION) {
      payload.ignoreCache = true;
    }
    const response = await map(payload, identity);

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);

    const urls = getMapLinks(response).map(x => x.url);
    expect(urls).toContain("https://www.hfea.gov.uk/first-page");
    expect(urls).toContain("https://www.hfea.gov.uk/second-page");
  }, 60_000);

  it.concurrent("sitemap=only returns no links when the only sitemap is deeply nested", async () => {
    const payload: Parameters<typeof map>[0] = {
      url: "https://www.hfea.gov.uk",
      sitemap: "only",
      useMock: "map-sitemap-deeply-nested-only",
    };
    if (TEST_PRODUCTION) {
      payload.ignoreCache = true;
    }
    const response = await map(payload, identity);

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.links).toEqual([]);
  }, 60_000);

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

  // TODO: port to new system
  it.concurrent("shows warning when results ≤ 1 and URL is not base domain", async () => {
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
  }, 60_000);

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "handles redirects correctly",
    async () => {
      const payload: Parameters<typeof map>[0] = {
        url: "http://firecrawl.com",
        limit: 5,
        sitemap: "only",
        useMock: "map-redirect",
      };
      if (TEST_PRODUCTION) {
        payload.useIndex = false;
        payload.ignoreCache = true;
      }
      const response = await map(payload, identity);

      if (response.statusCode !== 200) {
        console.warn(
          "Map redirect test failed",
          JSON.stringify(response.body, null, 2),
        );
      }

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      const links = getMapLinks(response);
      expect(links.length).toBeGreaterThan(0);

      expect(links.every(link => link.url.includes("firecrawl.dev"))).toBe(
        true,
      );
      expect(links.every(link => !link.url.includes("firecrawl.com"))).toBe(
        true,
      );
    },
    60_000,
  );
});
