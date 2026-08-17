import { describe, expect, test, jest } from "@jest/globals";
import { startCrawl, waitForCrawlCompletion } from "../../../v2/methods/crawl";
import { waitForBatchCompletion } from "../../../v2/methods/batch";

describe("v2.crawl unit", () => {
  test("startCrawl forwards ignoreRobotsTxt in request payload", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, id: "crawl-job", url: "https://api.firecrawl.dev/v2/crawl/crawl-job" },
    });

    await startCrawl({ post } as any, {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });

    expect(post).toHaveBeenCalledWith("/v2/crawl", {
      url: "https://example.com",
      ignoreRobotsTxt: true,
    });
  });

  test("waitForCrawlCompletion paginates only after the job completes", async () => {
    const get = jest.fn(async (url: string) => {
      if (String(url).includes("/v2/crawl/")) {
        return {
          status: 200,
          data: {
            success: true,
            status: "completed",
            completed: 1,
            total: 2,
            next: "https://api/n1",
            data: [{ markdown: "a" }],
          },
        };
      }
      return {
        status: 200,
        data: { success: true, next: null, data: [{ markdown: "b" }] },
      };
    });

    const res = await waitForCrawlCompletion({ get } as any, "job1");
    expect(res.data.map((d) => d.markdown)).toEqual(["a", "b"]);
    expect(res.next).toBeNull();
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/v2/crawl/job1",
      "https://api/n1",
    ]);
  });

  test("waitForBatchCompletion paginates only after the job completes", async () => {
    const get = jest.fn(async (url: string) => {
      if (String(url).includes("/v2/batch/scrape/")) {
        return {
          status: 200,
          data: {
            success: true,
            status: "completed",
            completed: 1,
            total: 2,
            next: "https://api/b1",
            data: [{ markdown: "a" }],
          },
        };
      }
      return {
        status: 200,
        data: { success: true, next: null, data: [{ markdown: "b" }] },
      };
    });

    const res = await waitForBatchCompletion({ get } as any, "jobB");
    expect(res.data.map((d) => d.markdown)).toEqual(["a", "b"]);
    expect(res.next).toBeNull();
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/v2/batch/scrape/jobB",
      "https://api/b1",
    ]);
  });
});
