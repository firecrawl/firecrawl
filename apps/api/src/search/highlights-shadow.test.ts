vi.mock("../config", () => ({
  config: {
    HIGHLIGHT_SHADOW_RATE: 1,
  },
}));

vi.mock("./highlights", () => ({
  highlightsEnvReady: vi.fn(() => true),
  searchHighlightURLs: vi.fn(() => []),
  runIndexedSearchHighlightsShadow: vi.fn(),
}));

import { config } from "../config";
import {
  highlightsEnvReady,
  runIndexedSearchHighlightsShadow,
  searchHighlightURLs,
} from "./highlights";
import { createSearchHighlightsShadowRunner } from "./highlights-shadow";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
} as any;

let runSearchHighlightsShadow = createSearchHighlightsShadowRunner(logger);

afterEach(() => {
  vi.clearAllMocks();
  config.HIGHLIGHT_SHADOW_RATE = 1;
  vi.mocked(highlightsEnvReady).mockReturnValue(true);
  runSearchHighlightsShadow = createSearchHighlightsShadowRunner(logger);
});

describe("runSearchHighlightsShadow", () => {
  it("runs without applying results and emits a content-free canonical log", async () => {
    vi.mocked(runIndexedSearchHighlightsShadow).mockResolvedValue({
      attempted: 10,
      indexHits: 7,
      replaced: 6,
      succeeded: true,
    });

    expect(
      runSearchHighlightsShadow({
        response: {} as any,
        query: "private query",
        requestId: "request-1",
        teamId: "team-1",
        zeroDataRetention: false,
      }),
    ).toBe("started");
    await new Promise(resolve => setImmediate(resolve));

    expect(searchHighlightURLs).toHaveBeenCalledWith({});
    expect(runIndexedSearchHighlightsShadow).toHaveBeenCalledWith(
      [],
      "private query",
      expect.objectContaining({ silent: true }),
      "request-1",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Search highlights shadow completed",
      expect.objectContaining({
        canonicalLog: "search/highlights-shadow",
        outcome: "completed",
        attempted: 10,
        indexHits: 7,
        wouldReplace: 6,
      }),
    );
    const fields = logger.info.mock.calls[0][1];
    expect(fields).not.toHaveProperty("query");
    expect(fields).not.toHaveProperty("markdown");
    expect(fields).not.toHaveProperty("highlights");
  });

  it("forwards concurrent shadow work without admission drops", async () => {
    vi.mocked(runIndexedSearchHighlightsShadow).mockResolvedValue({
      attempted: 1,
      indexHits: 1,
      replaced: 1,
      succeeded: true,
    });

    const input = {
      response: {} as any,
      query: "query",
      teamId: "team-1",
      zeroDataRetention: false,
    };
    expect(
      runSearchHighlightsShadow({ ...input, requestId: "request-1" }),
    ).toBe("started");
    expect(
      runSearchHighlightsShadow({ ...input, requestId: "request-2" }),
    ).toBe("started");
    await new Promise(resolve => setImmediate(resolve));
    expect(runIndexedSearchHighlightsShadow).toHaveBeenCalledTimes(2);
  });

  it("emits the content-free failure category", async () => {
    vi.mocked(runIndexedSearchHighlightsShadow).mockResolvedValue({
      attempted: 3,
      indexHits: 1,
      replaced: 0,
      succeeded: false,
      failureReason: "network",
    });

    runSearchHighlightsShadow({
      response: {} as any,
      query: "private query",
      requestId: "request-1",
      teamId: "team-1",
      zeroDataRetention: false,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.info).toHaveBeenCalledWith(
      "Search highlights shadow completed",
      expect.objectContaining({
        outcome: "failed",
        failureReason: "network",
      }),
    );
  });

  it("does not shadow ZDR, disabled, or unavailable requests", () => {
    const input = {
      response: {} as any,
      query: "query",
      requestId: "request-1",
      teamId: "team-1",
    };

    expect(
      runSearchHighlightsShadow({ ...input, zeroDataRetention: true }),
    ).toBe("skipped");

    config.HIGHLIGHT_SHADOW_RATE = 0;
    expect(
      runSearchHighlightsShadow({ ...input, zeroDataRetention: false }),
    ).toBe("skipped");

    config.HIGHLIGHT_SHADOW_RATE = 1;
    vi.mocked(highlightsEnvReady).mockReturnValue(false);
    expect(
      runSearchHighlightsShadow({ ...input, zeroDataRetention: false }),
    ).toBe("skipped");

    expect(runIndexedSearchHighlightsShadow).not.toHaveBeenCalled();
  });
});
