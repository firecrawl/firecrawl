import { verifyScrapeRobotsAccess } from "../robots-policy";

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
});
