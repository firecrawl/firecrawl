import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { searchArxiv } from "../../search/arxiv";
import { config } from "../../config";

// Minimal logger stub — the arxiv client only uses `.info` and `.warn`.
const makeLogger = () =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as any;

describe("searchArxiv", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = config.ARXIV_SEARCH_URL;
  });

  afterEach(() => {
    (config as any).ARXIV_SEARCH_URL = originalUrl;
  });

  it("returns [] when ARXIV_SEARCH_URL is not configured", async () => {
    (config as any).ARXIV_SEARCH_URL = undefined;
    const logger = makeLogger();

    const result = await searchArxiv({
      query: "retrieval augmented generation",
      limit: 5,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("ARXIV_SEARCH_URL is not configured"),
    );
  });

  it("returns [] when the query is empty", async () => {
    (config as any).ARXIV_SEARCH_URL = "http://example.internal/search";
    const logger = makeLogger();

    const result = await searchArxiv({
      query: "   ",
      limit: 5,
      logger,
    });

    expect(result).toEqual([]);
  });

  it("returns [] instead of throwing when ARXIV_SEARCH_URL is malformed", async () => {
    // `new URL("not-a-url")` throws; the client must catch that and degrade
    // to best-effort so a misconfigured env var never rejects the parent
    // search request.
    (config as any).ARXIV_SEARCH_URL = "not-a-url";
    const logger = makeLogger();

    await expect(
      searchArxiv({
        query: "retrieval augmented generation",
        limit: 5,
        logger,
      }),
    ).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Arxiv search API call failed"),
      expect.any(Object),
    );
  });
});
