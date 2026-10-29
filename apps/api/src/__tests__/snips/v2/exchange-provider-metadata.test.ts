import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { scrapeURL } from "../../../scraper/scrapeURL";
import { scrapeURLWithExchange } from "../../../scraper/scrapeURL/engines/exchange";
import { ALLOW_TEST_SUITE_WEBSITE, itIf, TEST_SUITE_WEBSITE } from "../lib";
import { scrapeTimeout } from "./lib";

const mocks = vi.hoisted(() => ({ robustFetch: vi.fn() }));

vi.mock("../../../scraper/scrapeURL/lib/fetch", () => ({
  robustFetch: mocks.robustFetch,
}));

const PROFILE_URL = "https://profiles.example/in/example-person";

const WATERFALL_RESPONSE = {
  success: true,
  accessEventId: "access-1",
  creditsCost: 30,
  data: {
    url: PROFILE_URL,
    title: "Example Person",
    markdown: "# Example Person",
    source: {
      provider: "firecrawl-enrich",
      recordId: PROFILE_URL,
      recordType: "professional_profile",
    },
    metadata: {
      canonicalUrl: PROFILE_URL,
      targetKind: "person",
      enrichment: {
        status: "matched",
        preferenceVersion: 1,
        source: { provider: "globex", capability: "person-profile" },
        steps: [
          {
            provider: "acme",
            capability: "person-profile",
            requestId: "step-1",
            status: "not_found",
            creditsCost: 10,
          },
          {
            provider: "globex",
            capability: "person-profile",
            requestId: "step-2",
            status: "matched",
            creditsCost: 20,
          },
        ],
        providerCredits: 30,
      },
    },
  },
};

const WATERFALL_PROVIDER = {
  id: "globex",
  creditsCost: 30,
  steps: [
    { provider: "acme", status: "not_found", creditsCost: 10 },
    { provider: "globex", status: "matched", creditsCost: 20 },
  ],
};

// Parses with the engine's own schema, as the real robustFetch does.
function exchangeResponds(response: unknown) {
  mocks.robustFetch.mockImplementation(async ({ schema }) =>
    schema.parse(response),
  );
}

function directResponse(metadata?: unknown) {
  return {
    success: true,
    accessEventId: "access-2",
    creditsCost: 12,
    data: {
      url: PROFILE_URL,
      title: "Example Person",
      markdown: "# Example Person",
      source: {
        provider: "acme",
        recordId: "example-person",
        recordType: "person",
      },
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
}

const stubMeta = () =>
  ({
    id: "test",
    url: PROFILE_URL,
    options: { formats: [{ type: "markdown" }] },
    internalOptions: { teamId: "team-1", orgId: "org-1" },
    featureFlags: new Set(),
    mock: null,
    abort: { asSignal: () => undefined },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  }) as any;

describe("Exchange provider metadata", () => {
  const originalExchangeUrl = config.FIRE_EXCHANGE_URL;

  beforeAll(() => {
    config.FIRE_EXCHANGE_URL = "http://test-exchange";
  });

  afterAll(() => {
    config.FIRE_EXCHANGE_URL = originalExchangeUrl;
  });

  beforeEach(() => {
    mocks.robustFetch.mockReset();
  });

  describe("exchange engine", () => {
    it("reports the matched waterfall step as the provider, with every step tried", async () => {
      exchangeResponds(WATERFALL_RESPONSE);

      const result = await scrapeURLWithExchange(stubMeta());

      expect(result.exchange).toEqual({
        accessEventId: "access-1",
        provider: WATERFALL_PROVIDER,
      });
    });

    it("reports a direct provider as its own single matched step", async () => {
      exchangeResponds(directResponse({ cacheState: "miss" }));

      const result = await scrapeURLWithExchange(stubMeta());

      expect(result.exchange?.provider).toEqual({
        id: "acme",
        creditsCost: 12,
        steps: [{ provider: "acme", status: "matched", creditsCost: 12 }],
      });
    });

    it.each([
      ["absent", undefined],
      ["not an object", { enrichment: "matched" }],
      [
        "missing its matched source",
        { enrichment: { status: "matched", steps: [] } },
      ],
      [
        "an empty waterfall",
        { enrichment: { source: { provider: "globex" }, steps: [] } },
      ],
      [
        "a negative step cost",
        {
          enrichment: {
            source: { provider: "globex" },
            steps: [{ provider: "globex", status: "matched", creditsCost: -1 }],
          },
        },
      ],
      [
        "missing a step status",
        {
          enrichment: {
            source: { provider: "globex" },
            steps: [{ provider: "globex", creditsCost: 12 }],
          },
        },
      ],
    ])(
      "falls back to the direct-provider shape when enrichment metadata is %s",
      async (_, metadata) => {
        exchangeResponds(directResponse(metadata));

        const result = await scrapeURLWithExchange(stubMeta());

        expect(result.markdown).toBe("# Example Person");
        expect(result.exchange?.provider).toEqual({
          id: "acme",
          creditsCost: 12,
          steps: [{ provider: "acme", status: "matched", creditsCost: 12 }],
        });
      },
    );
  });

  describe("scrape documents", () => {
    const runScrape = (url: string, forceEngine: "exchange" | "fetch") =>
      scrapeURL(
        randomUUID(),
        url,
        scrapeOptions.parse({ formats: ["markdown"], maxAge: 0 }),
        {
          teamId: "exchange-provider-metadata-test",
          orgId: null,
          forceEngine,
        },
        new CostTracking(),
      );

    it(
      "puts the provider on an Exchange-served document",
      async () => {
        exchangeResponds(WATERFALL_RESPONSE);

        const result = await runScrape(PROFILE_URL, "exchange");

        if (!result.success) throw result.error;
        expect(result.document.metadata.provider).toEqual(WATERFALL_PROVIDER);
        expect(result.exchange?.provider).toEqual(WATERFALL_PROVIDER);
      },
      scrapeTimeout,
    );

    itIf(ALLOW_TEST_SUITE_WEBSITE)(
      "leaves metadata.provider off documents the Exchange did not serve",
      async () => {
        const result = await runScrape(TEST_SUITE_WEBSITE, "fetch");

        if (!result.success) throw result.error;
        expect(result.exchange).toBeUndefined();
        expect(result.document.metadata.provider).toBeUndefined();
      },
      scrapeTimeout,
    );
  });
});
