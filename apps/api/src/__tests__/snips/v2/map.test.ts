import { expectMapToSucceed, map, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "map",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Map tests", () => {
  it.concurrent(
    "basic map succeeds",
    async () => {
      const response = await map(
        {
          url: "http://firecrawl.dev",
        },
        identity,
      );

      expectMapToSucceed(response);
    },
    60000,
  );

  it.concurrent(
    "times out properly",
    async () => {
      const response = await map(
        {
          url: "http://firecrawl.dev",
          timeout: 1,
        },
        identity,
      );

      expect(response.statusCode).toBe(408);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Map timed out");
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

  it.concurrent("sitemap=only respects limit", async () => {
    const response = await map(
      {
        url: "https://firecrawl.dev",
        sitemap: "only",
        limit: 10,
      },
      identity,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.links.length).toBe(10);
  });

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
});
