vi.mock("../config", () => ({
  config: {
    GOOGLE_WEB_RISK_API_KEY: "test-key",
  },
}));

import {
  filterSearchResponseWithWebRisk,
  normalizeFilterRiskyURLsOptions,
} from "./web-risk";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function mockWebRiskFetch(riskyUrls: Set<string>) {
  const fetchMock = vi.fn(async (url: URL) => {
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
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("filterSearchResponseWithWebRisk", () => {
  it("filters risky search results and scans duplicate URLs once", async () => {
    const fetchMock = mockWebRiskFetch(new Set(["https://bad.example"]));

    const result = await filterSearchResponseWithWebRisk(
      {
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
        news: [{ url: "https://bad.example", title: "bad news" }],
      },
      true,
      logger,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.scannedUrls).toBe(2);
    expect(result.filteredUrls).toBe(1);
    expect(result.response.web?.map(x => x.url)).toEqual([
      "https://safe.example",
    ]);
    expect(result.response.news).toEqual([]);
  });

  it("throws when failOpen is false and Google Web Risk errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "upstream failed",
      })),
    );

    await expect(
      filterSearchResponseWithWebRisk(
        {
          web: [
            {
              url: "https://safe.example",
              title: "safe",
              description: "safe",
            },
          ],
        },
        { failOpen: false },
        logger,
      ),
    ).rejects.toThrow("Google Web Risk returned 500");
  });
});

describe("normalizeFilterRiskyURLsOptions", () => {
  it("uses safe defaults for boolean shorthand", () => {
    expect(normalizeFilterRiskyURLsOptions(true)).toEqual({
      enabled: true,
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"],
      failOpen: true,
    });
  });
});
