import { describe, expect, jest, test } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";
import { SdkError } from "../../../v2/types";

const response = {
  success: true,
  results: [
    {
      id: "issue:firecrawl/firecrawl#1",
      url: "https://github.com/firecrawl/firecrawl/issues/1",
      passages: [
        {
          text: "evidence",
          citation_url:
            "https://github.com/firecrawl/firecrawl/issues/1#issuecomment-1",
        },
      ],
      license: { state: "licensed" as const, spdx_id: "MIT" },
    },
  ],
  repos: [
    {
      repo: "firecrawl/firecrawl",
      indexed: true,
      types: { issue: true, pullRequest: true, readme: true },
    },
  ],
  sources: [{ source: "firecrawl", indexed: false }],
};

describe("developerSearch", () => {
  test("forwards every dedicated developer filter", async () => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: response })),
    } as any;

    const client = new FirecrawlClient({
      apiKey: "test",
      apiUrl: "http://localhost",
    });
    (client as any).http = http;

    const result = await client.developerSearch("retry configuration", {
      k: 20,
      passages: 5,
      types: ["doc", "issue", "pull_request", "readme"],
      repos: ["firecrawl/firecrawl"],
      sources: ["firecrawl"],
      language: "TypeScript",
      topic: ["web-scraping"],
      license: "MIT",
      minStars: 100,
      maxStars: 50000,
      archived: false,
      fork: true,
      skills: "only",
    });

    expect(http.post).toHaveBeenCalledWith("/v2/search/developer", {
      query: "retry configuration",
      k: 20,
      passages: 5,
      types: ["doc", "issue", "pull_request", "readme"],
      repos: ["firecrawl/firecrawl"],
      sources: ["firecrawl"],
      language: "TypeScript",
      topic: ["web-scraping"],
      license: "MIT",
      min_stars: 100,
      max_stars: 50000,
      archived: false,
      fork: true,
      skills: "only",
    });
    expect(result).toEqual(response);
  });

  test("normalizes transport errors to SdkError", async () => {
    const http = {
      post: jest.fn(async () => {
        throw {
          isAxiosError: true,
          code: "ECONNABORTED",
          message: "request timed out",
        };
      }),
    } as any;
    const client = new FirecrawlClient({
      apiKey: "test",
      apiUrl: "http://localhost",
    });
    (client as any).http = http;

    await expect(
      client.developerSearch("network failure"),
    ).rejects.toBeInstanceOf(SdkError);
  });

  test("accepts the flattened SPDX license response shape", async () => {
    const flattened = {
      ...response,
      results: [{ ...response.results[0], license: "MIT" }],
    };
    const http = {
      post: jest.fn(async () => ({ status: 200, data: flattened })),
    } as any;

    const client = new FirecrawlClient({
      apiKey: "test",
      apiUrl: "http://localhost",
    });
    (client as any).http = http;

    await expect(client.developerSearch("license shape")).resolves.toEqual(
      flattened,
    );
  });
});
