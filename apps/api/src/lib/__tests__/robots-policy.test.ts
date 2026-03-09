import { verifyScrapeRobotsAccess } from "../robots-policy";
import { AbortManagerThrownError } from "../../scraper/scrapeURL/lib/abortManager";

describe("verifyScrapeRobotsAccess", () => {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    logger.info.mockReset();
    logger.debug.mockReset();
  });

  it("fails closed when strict robots verification cannot complete", async () => {
    await expect(
      verifyScrapeRobotsAccess(
        {
          url: "https://example.com/protected",
          id: "test:strict-robots-fetch-failure",
          logger,
          robotsMode: "strict",
          zeroDataRetention: false,
        },
        {
          fetchRobotsTxt: jest
            .fn()
            .mockRejectedValue(new Error("robots fetch failed")),
          createRobotsChecker: jest.fn(),
          isUrlAllowedByRobots: jest.fn(),
          getRobotsUserAgents: jest.fn(),
        },
      ),
    ).rejects.toMatchObject({
      message: "Failed to verify robots.txt in strict mode",
    });
  });

  it("uses the caller user agent for robots allow/deny evaluation", async () => {
    const fetchRobotsTxt = jest.fn().mockResolvedValue({
      content: "User-agent: DebTestBot\nDisallow: /blocked\nUser-agent: *\nAllow: /",
      url: "https://example.com/robots.txt",
    });
    const createRobotsChecker = jest.fn().mockReturnValue({
      robots: { source: "robots-parser" },
    });
    const isUrlAllowedByRobots = jest.fn().mockReturnValue(false);
    const getRobotsUserAgents = jest
      .fn()
      .mockReturnValue(["DebTestBot/1.0", "DebTestBot"]);

    await expect(
      verifyScrapeRobotsAccess(
        {
          url: "https://example.com/blocked",
          id: "test:custom-user-agent-robots",
          logger,
          zeroDataRetention: false,
          headers: {
            "User-Agent": "DebTestBot/1.0",
          },
        },
        {
          fetchRobotsTxt,
          createRobotsChecker,
          isUrlAllowedByRobots,
          getRobotsUserAgents,
        },
      ),
    ).rejects.toMatchObject({
      message: "URL blocked by robots.txt",
    });

    expect(fetchRobotsTxt).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "User-Agent": "DebTestBot/1.0",
        },
      }),
      "test:custom-user-agent-robots",
      logger,
      undefined,
    );
    expect(getRobotsUserAgents).toHaveBeenCalledWith("DebTestBot/1.0");
    expect(isUrlAllowedByRobots).toHaveBeenCalledWith(
      "https://example.com/blocked",
      { source: "robots-parser" },
      ["DebTestBot/1.0", "DebTestBot"],
    );
  });

  it("treats an empty cached robots.txt as a cache hit", async () => {
    const fetchRobotsTxt = jest.fn();
    const createRobotsChecker = jest.fn().mockReturnValue({
      robots: { source: "robots-parser" },
    });
    const isUrlAllowedByRobots = jest.fn().mockReturnValue(true);

    await expect(
      verifyScrapeRobotsAccess(
        {
          url: "https://example.com/allowed",
          id: "test:cached-empty-robots",
          logger,
          cachedRobotsTxt: "",
          zeroDataRetention: false,
        },
        {
          fetchRobotsTxt,
          createRobotsChecker,
          isUrlAllowedByRobots,
          getRobotsUserAgents: jest.fn().mockReturnValue(["FireCrawlAgent"]),
        },
      ),
    ).resolves.toBeUndefined();

    expect(fetchRobotsTxt).not.toHaveBeenCalled();
    expect(createRobotsChecker).toHaveBeenCalledWith(
      "https://example.com/allowed",
      "",
    );
  });

  it("rethrows abort errors instead of allowing scrape in respect mode", async () => {
    const abortError = new AbortManagerThrownError(
      "external",
      new Error("Robots.txt fetch aborted"),
    );

    await expect(
      verifyScrapeRobotsAccess(
        {
          url: "https://example.com/allowed",
          id: "test:robots-fetch-abort",
          logger,
          zeroDataRetention: false,
        },
        {
          fetchRobotsTxt: jest.fn().mockRejectedValue(abortError),
          createRobotsChecker: jest.fn(),
          isUrlAllowedByRobots: jest.fn(),
          getRobotsUserAgents: jest.fn(),
        },
      ),
    ).rejects.toBe(abortError);

    expect(logger.debug).not.toHaveBeenCalled();
  });
});
