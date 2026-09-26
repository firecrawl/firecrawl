export const MAX_CRAWL_STATUS_PAGE_SIZE = 1000;

type CrawlStatusPaginationQuery = {
  skip?: unknown;
  limit?: unknown;
};

type ParsedCrawlStatusPagination = {
  start: number;
  limit?: number;
};

type CrawlStatusPaginationError = {
  error: string;
};

type CrawlStatusNextInput = {
  protocol: string;
  host: string;
  jobId: string;
  isBatch: boolean;
  nextSkip: number;
  hasMore: boolean;
  limit?: number;
};

export function parseCrawlStatusPagination(
  query: CrawlStatusPaginationQuery,
): ParsedCrawlStatusPagination | CrawlStatusPaginationError {
  const rawSkip = query.skip === undefined ? "0" : query.skip;
  if (Array.isArray(rawSkip)) {
    return {
      error: "Invalid pagination: skip must be a single value, not an array",
    };
  }
  if (typeof rawSkip !== "string") {
    return { error: "Invalid pagination: skip must be a string" };
  }
  if (!/^\d+$/.test(rawSkip)) {
    return {
      error:
        "Invalid pagination: skip must be a non-negative integer without trailing characters",
    };
  }

  const start = Number(rawSkip);
  if (!Number.isSafeInteger(start)) {
    return {
      error: "Invalid pagination: skip must be a non-negative safe integer",
    };
  }

  const rawLimit = query.limit;
  if (rawLimit === undefined) {
    return { start };
  }
  if (Array.isArray(rawLimit)) {
    return {
      error: "Invalid pagination: limit must be a single value, not an array",
    };
  }
  if (typeof rawLimit !== "string") {
    return { error: "Invalid pagination: limit must be a string" };
  }
  if (!/^\d+$/.test(rawLimit)) {
    return {
      error:
        "Invalid pagination: limit must be a positive integer without trailing characters",
    };
  }

  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CRAWL_STATUS_PAGE_SIZE
  ) {
    return {
      error: `Invalid pagination: limit must be an integer between 1 and ${MAX_CRAWL_STATUS_PAGE_SIZE}`,
    };
  }

  return { start, limit };
}

export function buildCrawlStatusNext(
  input: CrawlStatusNextInput,
): string | undefined {
  if (
    !input.hasMore ||
    !Number.isSafeInteger(input.nextSkip) ||
    input.nextSkip < 0
  ) {
    return undefined;
  }

  const limit = input.limit === undefined ? "" : `&limit=${input.limit}`;
  return `${input.protocol}://${input.host}/v2/${
    input.isBatch ? "batch/scrape" : "crawl"
  }/${input.jobId}?skip=${input.nextSkip}${limit}`;
}
