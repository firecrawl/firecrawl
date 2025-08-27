// crawler.test.ts
import { WebCrawler } from "../crawler";
import axios from "axios";
import robotsParser from "robots-parser";

jest.mock("axios");
jest.mock("robots-parser");

describe("WebCrawler", () => {
  let crawler: WebCrawler;
  const mockAxios = axios as jest.Mocked<typeof axios>;
  const mockRobotsParser = robotsParser as jest.MockedFunction<
    typeof robotsParser
  >;

  let maxCrawledDepth: number;

  beforeEach(() => {
    // Setup default mocks
    mockAxios.get.mockImplementation((url) => {
      if (url.includes("robots.txt")) {
        return Promise.resolve({ data: "User-agent: *\nAllow: /" });
      } else if (url.includes("sitemap.xml")) {
        return Promise.resolve({ data: "sitemap content" }); // You would normally parse this to URLs
      }
      return Promise.resolve({ data: "<html></html>" });
    });

    mockRobotsParser.mockReturnValue({
      isAllowed: jest.fn().mockReturnValue(true),
      isDisallowed: jest.fn().mockReturnValue(false),
      getMatchingLineNumber: jest.fn().mockReturnValue(0),
      getCrawlDelay: jest.fn().mockReturnValue(0),
      getSitemaps: jest.fn().mockReturnValue([]),
      getPreferredHost: jest.fn().mockReturnValue("example.com"),
    });
  });

  it("should respect the limit parameter by not returning more links than specified", async () => {
    const initialUrl = "http://example.com";
    const limit = 2; // Set a limit for the number of links

    crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl: initialUrl,
      includes: [],
      excludes: [],
      limit: limit, // Apply the limit
      maxCrawledDepth: 10,
    });

    // Mock sitemap fetching function to return more links than the limit
    crawler["tryFetchSitemapLinks"] = jest
      .fn()
      .mockResolvedValue([
        initialUrl,
        initialUrl + "/page1",
        initialUrl + "/page2",
        initialUrl + "/page3",
      ]);

    const filteredLinks = await crawler["filterLinks"](
      [
        initialUrl,
        initialUrl + "/page1",
        initialUrl + "/page2",
        initialUrl + "/page3",
      ],
      limit,
      10,
    );

    expect(filteredLinks.links.length).toBe(limit); // Check if the number of results respects the limit
    expect(filteredLinks.links).toEqual([initialUrl, initialUrl + "/page1"]);
  });
});
