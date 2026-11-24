vi.mock("../../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      ENABLE_SEARCH_INDEX: true,
      SEARCH_SERVICE_URL: "http://search.test",
      SEARCH_INDEX_SAMPLE_RATE: 1,
    },
  };
});

vi.mock("../../../lib/search-index-client", () => ({
  indexDocumentIfEnabled: vi.fn().mockResolvedValue(undefined),
}));

import { indexDocumentIfEnabled } from "../../../lib/search-index-client";
import { sendDocumentToSearchIndex } from "./sendToSearchIndex";

function meta(headers?: Record<string, string>): any {
  return {
    url: "https://example.com/page",
    internalOptions: {},
    options: { headers },
    logger: { debug: vi.fn(), error: vi.fn() },
  };
}

function document(): any {
  return {
    markdown: "content ".repeat(50),
    metadata: { statusCode: 200, indexId: "11111111-1111-4111-8111-111111111111" },
  };
}

beforeEach(() => {
  vi.mocked(indexDocumentIfEnabled).mockClear();
});

describe("sendDocumentToSearchIndex", () => {
  it("indexes a public page", async () => {
    await sendDocumentToSearchIndex(meta(), document());
    expect(indexDocumentIfEnabled).toHaveBeenCalledTimes(1);
  });

  it("indexes a page fetched with non-credential headers", async () => {
    await sendDocumentToSearchIndex(
      meta({ "Accept-Language": "en" }),
      document(),
    );
    expect(indexDocumentIfEnabled).toHaveBeenCalledTimes(1);
  });

  it.each<Record<string, string>>([
    { Authorization: "Bearer token" },
    { authorization: "Bearer token" },
    { AUTHORIZATION: "Bearer token" },
    { Cookie: "session=abc" },
    { cookie: "session=abc" },
    { "X-API-Key": "key" },
    { "x-api-key": "key" },
    { "Api-Key": "key" },
    { "Proxy-Authorization": "Basic abc" },
  ])("skips a page fetched with %o", async headers => {
    await sendDocumentToSearchIndex(meta(headers), document());
    expect(indexDocumentIfEnabled).not.toHaveBeenCalled();
  });
});
