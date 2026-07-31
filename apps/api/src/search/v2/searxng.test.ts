import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { config } from "../../config";
import { searxng_search } from "./searxng";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    isAxiosError: (error: any) => error?.isAxiosError === true,
  },
}));

const getMock = vi.mocked(axios.get);
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe("SearXNG adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.SEARXNG_ENDPOINT = "http://searxng.test";
  });

  it("passes the selected engine group and retains ranking diagnostics", async () => {
    getMock.mockResolvedValue({
      data: {
        results: [
          {
            url: "https://github.com/firecrawl/firecrawl",
            title: "firecrawl/firecrawl",
            content: "Web scraping API",
            engine: "github",
            engines: ["github"],
            score: 4.2,
            publishedDate: "2026-07-30T00:00:00Z",
          },
        ],
        unresponsive_engines: [["gitlab", "timeout"]],
      },
    });

    const result = await searxng_search("firecrawl", {
      num_results: 5,
      engines: ["github", "gitlab"],
      profile: "developer",
      logger,
    });

    expect(getMock).toHaveBeenCalledWith(
      "http://searxng.test/search",
      expect.objectContaining({
        params: expect.objectContaining({
          q: "firecrawl",
          engines: "github,gitlab",
          categories: "",
        }),
        headers: expect.objectContaining({
          "X-Forwarded-For": "127.0.0.1",
        }),
      }),
    );
    expect((result.web?.[0] as any).__search).toEqual({
      engine: "github",
      engines: ["github"],
      score: 4.2,
      publishedDate: "2026-07-30T00:00:00Z",
      profile: "developer",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "SearXNG engine group completed",
      expect.objectContaining({
        unresponsiveEngines: [["gitlab", "timeout"]],
      }),
    );
  });

  it("retries one transient transport failure", async () => {
    getMock
      .mockRejectedValueOnce({ isAxiosError: true })
      .mockResolvedValueOnce({ data: { results: [] } });

    await searxng_search("firecrawl", {
      num_results: 1,
      engines: ["github"],
      profile: "developer",
      logger,
    });

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Retrying transient SearXNG request failure",
      expect.any(Object),
    );
  });
});
