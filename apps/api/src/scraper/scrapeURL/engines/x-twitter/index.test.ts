import { generateText } from "ai";
import { config } from "../../../../config";
import {
  XTwitterConfigurationError,
  XTwitterProfileNotFoundError,
} from "../../error";
import { safeMarkdownToHtml } from "../pdf/markdownToHtml";
import { scrapeURLWithXTwitter, xTwitterMaxReasonableTime } from "./index";

const sdk = vi.hoisted(() => ({
  constructor: vi.fn(),
  getReplies: vi.fn(),
  getThread: vi.fn(),
  retrieve: vi.fn(),
  search: vi.fn(),
  searchUsers: vi.fn(),
}));

vi.mock("x-twitter-scraper", () => ({
  default: class MockXTwitterScraper {
    x = {
      tweets: {
        getReplies: sdk.getReplies,
        getThread: sdk.getThread,
        retrieve: sdk.retrieve,
        search: sdk.search,
      },
      users: { retrieveSearch: sdk.searchUsers },
    };

    constructor(options: unknown) {
      sdk.constructor(options);
    }
  },
}));

vi.mock("@ai-sdk/xai", () => ({
  xai: {
    responses: () => "grok-model",
    tools: { xSearch: () => "x-search-tool" },
  },
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
  Output: { object: (options: unknown) => options },
}));

vi.mock("../pdf/markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async markdown => `<article>${markdown}</article>`),
}));

const mutableConfig = config as typeof config & {
  XAI_API_KEY?: string;
  X_TWITTER_SCRAPER_API_KEY?: string;
  X_TWITTER_SCRAPER_BASE_URL?: string;
};
const originalConfig = {
  XAI_API_KEY: config.XAI_API_KEY,
  X_TWITTER_SCRAPER_API_KEY: config.X_TWITTER_SCRAPER_API_KEY,
  X_TWITTER_SCRAPER_BASE_URL: config.X_TWITTER_SCRAPER_BASE_URL,
};

function makeMeta(url: string) {
  const signal = new AbortController().signal;
  return {
    id: "x-twitter-test",
    url,
    rewrittenUrl: undefined,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    abort: {
      asSignal: vi.fn(() => signal),
      scrapeTimeout: vi.fn(() => 30000),
      throwIfAborted: vi.fn(),
    },
  } as any;
}

function searchTweet(
  id: string,
  text: string,
  username: string,
  name = username,
) {
  return {
    id,
    text,
    author: { id: `user-${username}`, name, username },
    bookmarkCount: 0,
    likeCount: 12,
    quoteCount: 0,
    replyCount: 0,
    retweetCount: 3,
    viewCount: 100,
    createdAt: "2026-08-23T12:00:00.000Z",
  };
}

describe("X/Twitter engine with Xquik", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mutableConfig.X_TWITTER_SCRAPER_API_KEY = "xquik-test-key";
    mutableConfig.X_TWITTER_SCRAPER_BASE_URL = "https://xquik.test/api/v1";
    mutableConfig.XAI_API_KEY = undefined;
    vi.mocked(safeMarkdownToHtml).mockImplementation(
      async markdown => `<article>${markdown}</article>`,
    );
    sdk.getReplies.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      tweets: [],
    });
    sdk.getThread.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      tweets: [],
    });
  });

  afterAll(() => {
    mutableConfig.XAI_API_KEY = originalConfig.XAI_API_KEY;
    mutableConfig.X_TWITTER_SCRAPER_API_KEY =
      originalConfig.X_TWITTER_SCRAPER_API_KEY;
    mutableConfig.X_TWITTER_SCRAPER_BASE_URL =
      originalConfig.X_TWITTER_SCRAPER_BASE_URL;
  });

  it("maps a post, its thread, and its top replies", async () => {
    const meta = makeMeta("https://twitter.com/firecrawl/status/123456789");
    const source = searchTweet(
      "123456789",
      "# Release\nNew crawler",
      "firecrawl",
      "Firecrawl",
    );
    sdk.retrieve.mockResolvedValue({ tweet: source, author: source.author });
    sdk.getThread.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      tweets: [source, searchTweet("123456790", "Second post", "firecrawl")],
    });
    sdk.getReplies.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      tweets: [searchTweet("123456791", "Useful reply", "reader", "Reader")],
    });

    const result = await scrapeURLWithXTwitter(meta);
    const signal = sdk.retrieve.mock.calls[0][1].signal;

    expect(sdk.constructor).toHaveBeenCalledWith({
      apiKey: "xquik-test-key",
      baseURL: "https://xquik.test/api/v1",
      logger: meta.logger,
      maxRetries: 0,
      timeout: 30000,
    });
    expect(sdk.retrieve).toHaveBeenCalledWith("123456789", { signal });
    expect(sdk.getThread).toHaveBeenCalledWith(
      "123456789",
      { fromUser: "firecrawl", pageSize: 100 },
      { signal },
    );
    expect(sdk.getReplies).toHaveBeenCalledWith(
      "123456789",
      { excludeOriginalAuthor: true, pageSize: 5, sort: "likes" },
      { signal },
    );
    expect(result.url).toBe("https://x.com/firecrawl/status/123456789");
    expect(result.markdown).toContain("## Post\n\n> # Release\n> New crawler");
    expect(result.markdown).toContain(
      "https://x.com/firecrawl/status/123456790",
    );
    expect(result.markdown).toContain("https://x.com/reader/status/123456791");
    expect(safeMarkdownToHtml).toHaveBeenCalledWith(
      result.markdown,
      meta.logger,
      meta.id,
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith("Fetching X/Twitter data", {
      kind: "post",
      provider: "Xquik",
      url: "https://x.com/firecrawl/status/123456789",
    });
  });

  it("resolves an exact profile and returns its latest top-level posts", async () => {
    const meta = makeMeta("https://x.com/Firecrawl");
    sdk.searchUsers.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      users: [
        {
          id: "user-firecrawl",
          name: "Firecrawl",
          username: "firecrawl",
          description: "Turn websites into LLM-ready data.",
          followers: 45000,
          isBlueVerified: true,
          profilePicture: "https://pbs.twimg.com/profile.jpg",
        },
      ],
    });
    sdk.search.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      tweets: [searchTweet("223456789", "Crawler update", "firecrawl")],
    });

    const result = await scrapeURLWithXTwitter(meta);
    const signal = sdk.searchUsers.mock.calls[0][1].signal;

    expect(sdk.searchUsers).toHaveBeenCalledWith(
      { q: "Firecrawl", usernameContains: "Firecrawl" },
      { signal },
    );
    expect(sdk.search).toHaveBeenCalledWith(
      {
        q: "from:firecrawl",
        fromUser: "firecrawl",
        limit: 5,
        queryType: "Latest",
        replies: "exclude",
        retweets: "exclude",
      },
      { signal },
    );
    expect(result.markdown).toContain("# Firecrawl (@firecrawl)");
    expect(result.markdown).toContain("Followers: 45,000");
    expect(result.markdown).toContain("Verified: yes");
    expect(result.markdown).toContain(
      "https://x.com/firecrawl/status/223456789",
    );
    expect(sdk.search.mock.calls[0][1].signal).toBe(signal);
    expect(xTwitterMaxReasonableTime(meta)).toBe(31000);
  });

  it("rejects a fuzzy user-search result", async () => {
    sdk.searchUsers.mockResolvedValue({
      has_next_page: false,
      next_cursor: "",
      users: [{ id: "other", name: "Other", username: "firecrawl_help" }],
    });

    await expect(
      scrapeURLWithXTwitter(makeMeta("https://x.com/firecrawl")),
    ).rejects.toEqual(new XTwitterProfileNotFoundError("firecrawl"));
    expect(sdk.search).not.toHaveBeenCalled();
  });

  it("keeps Grok as the fallback when Xquik is not configured", async () => {
    mutableConfig.X_TWITTER_SCRAPER_API_KEY = undefined;
    mutableConfig.XAI_API_KEY = "xai-test-key";
    vi.mocked(generateText).mockResolvedValue({
      output: {
        displayName: "Firecrawl",
        username: "firecrawl",
        profilePicUrl: null,
        bio: null,
        followers: 45000,
        accountVerified: true,
        url: "https://x.com/firecrawl",
        latestPosts: [],
      },
    } as any);

    const result = await scrapeURLWithXTwitter(
      makeMeta("https://x.com/firecrawl"),
    );

    expect(generateText).toHaveBeenCalledOnce();
    expect(sdk.constructor).not.toHaveBeenCalled();
    expect(result.markdown).toContain("# Firecrawl (@firecrawl)");
  });

  it("does not retry through Grok after an Xquik failure", async () => {
    mutableConfig.XAI_API_KEY = "xai-test-key";
    sdk.retrieve.mockRejectedValue(new Error("Xquik request failed"));

    await expect(
      scrapeURLWithXTwitter(
        makeMeta("https://x.com/firecrawl/status/123456789"),
      ),
    ).rejects.toThrow("Xquik request failed");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("reports both supported provider keys when neither is configured", async () => {
    mutableConfig.X_TWITTER_SCRAPER_API_KEY = undefined;
    mutableConfig.XAI_API_KEY = undefined;

    await expect(
      scrapeURLWithXTwitter(makeMeta("https://x.com/firecrawl")),
    ).rejects.toEqual(new XTwitterConfigurationError());
  });
});
