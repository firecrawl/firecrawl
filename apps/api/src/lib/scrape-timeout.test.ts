describe("scrape timeout configuration", () => {
  const originalScrapeTimeout = process.env.SCRAPE_TIMEOUT_MS;

  afterEach(() => {
    if (originalScrapeTimeout === undefined) {
      delete process.env.SCRAPE_TIMEOUT_MS;
    } else {
      process.env.SCRAPE_TIMEOUT_MS = originalScrapeTimeout;
    }
    jest.resetModules();
  });

  it("uses SCRAPE_TIMEOUT_MS when configured", async () => {
    jest.resetModules();
    process.env.SCRAPE_TIMEOUT_MS = "45000";

    const { DEFAULT_LEGACY_SCRAPE_TIMEOUT_MS, DEFAULT_SCRAPE_TIMEOUT_MS } =
      require("./scrape-timeout") as typeof import("./scrape-timeout.js");

    expect(DEFAULT_SCRAPE_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_LEGACY_SCRAPE_TIMEOUT_MS).toBe(45_000);
  });
});
