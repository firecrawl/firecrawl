import type { ScrapeJobSingleUrls } from "../types";
import { checkScrapeJobPermissions } from "./scrape-job-permissions";
import { UNSUPPORTED_SITE_MESSAGE } from "./strings";

const baseJobData: ScrapeJobSingleUrls = {
  mode: "single_urls",
  url: "https://example.com",
  team_id: "team-1",
  scrapeOptions: {} as any,
  internalOptions: { teamId: "team-1" },
  origin: "api",
  zeroDataRetention: false,
  apiKeyId: null,
};

describe("checkScrapeJobPermissions", () => {
  const isBlocked = vi.fn((url: string) => {
    const hostname = new URL(url).hostname;
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  });

  beforeEach(() => {
    isBlocked.mockClear();
  });

  it("rejects blocked scrape job URLs", () => {
    const result = checkScrapeJobPermissions(
      {
        ...baseJobData,
        url: "https://www.linkedin.com/in/example",
      },
      null,
      isBlocked,
    );

    expect(result.error).toBe(UNSUPPORTED_SITE_MESSAGE);
    expect(isBlocked).toHaveBeenCalledWith(
      "https://www.linkedin.com/in/example",
      null,
      {
        team_id: "team-1",
        origin: "api",
      },
    );
  });

  it("allows unblocked scrape job URLs", () => {
    const result = checkScrapeJobPermissions(baseJobData, null, isBlocked);

    expect(result.error).toBeUndefined();
  });

  it("mirrors scrape permissions for nested scrape options", () => {
    const result = checkScrapeJobPermissions(
      {
        ...baseJobData,
        scrapeOptions: {
          location: { country: "us-whitelist" },
        } as any,
      },
      null,
      isBlocked,
    );

    expect(result.error).toContain("Static IP addresses are not enabled");
  });

  it("allows nested scrape options when the team has permission", () => {
    const result = checkScrapeJobPermissions(
      {
        ...baseJobData,
        scrapeOptions: {
          location: { country: "us-whitelist" },
        } as any,
      },
      { ipWhitelist: true },
      isBlocked,
    );

    expect(result.error).toBeUndefined();
  });

  it("mirrors crawl permission checks for crawler options", () => {
    const result = checkScrapeJobPermissions(
      {
        ...baseJobData,
        crawlerOptions: { ignoreRobotsTxt: true },
      },
      null,
      isBlocked,
    );

    expect(result.error).toContain("ignoreRobotsTxt parameter");
  });
});
