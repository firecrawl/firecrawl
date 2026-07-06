vi.mock("../config", () => ({
  config: {
    GOOGLE_WEB_RISK_API_KEY: "test-key",
  },
}));

vi.mock("./v2", () => ({
  search: vi.fn(),
}));

vi.mock("../lib/tracking", () => ({
  trackSearchRequest: vi.fn(() => Promise.resolve()),
  trackSearchResults: vi.fn(() => Promise.resolve()),
}));

import type { Mock } from "vitest";
import { executeSearch } from "./execute";
import { search } from "./v2";

const searchMock = search as Mock;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function mockWebRiskFetch(riskyUrls: Set<string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      const scannedUrl = url.searchParams.get("uri");
      return {
        ok: true,
        status: 200,
        json: async () =>
          scannedUrl && riskyUrls.has(scannedUrl)
            ? { threat: { threatTypes: ["MALWARE"] } }
            : {},
        text: async () => "",
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("executeSearch", () => {
  it("adds two search credits per URL scanned by Web Risk", async () => {
    searchMock.mockResolvedValue({
      web: [
        {
          url: "https://safe.example",
          title: "safe",
          description: "safe",
        },
        {
          url: "https://bad.example",
          title: "bad",
          description: "bad",
        },
      ],
    });
    mockWebRiskFetch(new Set(["https://bad.example"]));

    const result = await executeSearch(
      {
        query: "example",
        limit: 10,
        sources: [{ type: "web" }],
        filterRiskyURLs: true,
        timeout: 60_000,
      },
      {
        teamId: "team-1",
        origin: "api",
        apiKeyId: 1,
        flags: null,
        requestId: "req-1",
        jobId: "job-1",
        apiVersion: "v2",
      },
      logger,
    );

    expect(result.response.web?.map(x => x.url)).toEqual([
      "https://safe.example",
    ]);
    expect(result.totalResultsCount).toBe(1);
    expect(result.searchCredits).toBe(6);
    expect(result.totalCredits).toBe(6);
  });
});
