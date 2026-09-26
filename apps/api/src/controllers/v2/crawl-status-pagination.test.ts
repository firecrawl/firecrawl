import { describe, expect, it } from "vitest";
import {
  MAX_CRAWL_STATUS_PAGE_SIZE,
  buildCrawlStatusNext,
  parseCrawlStatusPagination,
} from "./crawl-status-pagination";

describe("parseCrawlStatusPagination", () => {
  it("defaults omitted and zero skip to the first position", () => {
    expect(parseCrawlStatusPagination({})).toEqual({ start: 0 });
    expect(parseCrawlStatusPagination({ skip: "0" })).toEqual({ start: 0 });
  });

  it("accepts safe large offsets and rejects unsafe values", () => {
    expect(
      parseCrawlStatusPagination({ skip: String(Number.MAX_SAFE_INTEGER) }),
    ).toEqual({ start: Number.MAX_SAFE_INTEGER });
    expect(
      parseCrawlStatusPagination({ skip: "100000000000000000000" }),
    ).toEqual({
      error: "Invalid pagination: skip must be a non-negative safe integer",
    });
  });

  it("rejects array, non-numeric, and negative skip values", () => {
    expect(parseCrawlStatusPagination({ skip: ["0", "1"] })).toEqual({
      error: "Invalid pagination: skip must be a single value, not an array",
    });
    expect(parseCrawlStatusPagination({ skip: "10xyz" })).toEqual({
      error:
        "Invalid pagination: skip must be a non-negative integer without trailing characters",
    });
    expect(parseCrawlStatusPagination({ skip: "-1" })).toEqual({
      error:
        "Invalid pagination: skip must be a non-negative integer without trailing characters",
    });
  });

  it("accepts the page-size boundary and rejects invalid limits", () => {
    expect(
      parseCrawlStatusPagination({
        skip: "0",
        limit: String(MAX_CRAWL_STATUS_PAGE_SIZE),
      }),
    ).toEqual({ start: 0, limit: MAX_CRAWL_STATUS_PAGE_SIZE });

    expect(parseCrawlStatusPagination({ limit: ["1", "2"] })).toEqual({
      error: "Invalid pagination: limit must be a single value, not an array",
    });
    expect(parseCrawlStatusPagination({ limit: "1.5" })).toEqual({
      error:
        "Invalid pagination: limit must be a positive integer without trailing characters",
    });
    expect(parseCrawlStatusPagination({ limit: "-1" })).toEqual({
      error:
        "Invalid pagination: limit must be a positive integer without trailing characters",
    });
    expect(parseCrawlStatusPagination({ limit: "0" })).toEqual({
      error: `Invalid pagination: limit must be an integer between 1 and ${MAX_CRAWL_STATUS_PAGE_SIZE}`,
    });
    expect(
      parseCrawlStatusPagination({
        limit: String(MAX_CRAWL_STATUS_PAGE_SIZE + 1),
      }),
    ).toEqual({
      error: `Invalid pagination: limit must be an integer between 1 and ${MAX_CRAWL_STATUS_PAGE_SIZE}`,
    });
  });
});

describe("buildCrawlStatusNext", () => {
  const request = {
    protocol: "https",
    host: "api.firecrawl.dev",
    jobId: "00000000-0000-7000-8000-000000000000",
    nextSkip: 100,
    hasMore: true,
    limit: 50,
  };

  it("builds followable crawl and batch continuations", () => {
    expect(buildCrawlStatusNext({ ...request, isBatch: false })).toBe(
      "https://api.firecrawl.dev/v2/crawl/00000000-0000-7000-8000-000000000000?skip=100&limit=50",
    );
    expect(buildCrawlStatusNext({ ...request, isBatch: true })).toBe(
      "https://api.firecrawl.dev/v2/batch/scrape/00000000-0000-7000-8000-000000000000?skip=100&limit=50",
    );
  });

  it("omits limit when the request used the default page size", () => {
    expect(
      buildCrawlStatusNext({
        ...request,
        isBatch: false,
        limit: undefined,
      }),
    ).toBe(
      "https://api.firecrawl.dev/v2/crawl/00000000-0000-7000-8000-000000000000?skip=100",
    );
  });

  it("keeps safe large continuations", () => {
    expect(
      buildCrawlStatusNext({
        ...request,
        isBatch: true,
        nextSkip: Number.MAX_SAFE_INTEGER,
        limit: undefined,
      }),
    ).toBe(
      "https://api.firecrawl.dev/v2/batch/scrape/00000000-0000-7000-8000-000000000000?skip=9007199254740991",
    );
  });

  it("omits next when there is no further page or the offset is unsafe", () => {
    expect(
      buildCrawlStatusNext({ ...request, isBatch: false, hasMore: false }),
    ).toBeUndefined();
    expect(
      buildCrawlStatusNext({
        ...request,
        isBatch: false,
        nextSkip: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeUndefined();
    expect(
      buildCrawlStatusNext({
        ...request,
        isBatch: true,
        nextSkip: -1,
      }),
    ).toBeUndefined();
  });
});
