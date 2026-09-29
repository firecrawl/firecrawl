import type { Meta } from "..";
import { config } from "../../../config";
import {
  EngineError,
  EnrichmentNotEnabledError,
  ThirdPartyDataTermsRequiredError,
} from "../error";
import { robustFetch } from "../lib/fetch";
import { scrapeURLWithExchange } from "./exchange";

vi.mock("../lib/fetch", () => ({ robustFetch: vi.fn() }));

const originalExchangeUrl = config.FIRE_EXCHANGE_URL;
const access = {
  apollo: { status: "enabled", termsKey: "apollo", termsVersion: "F-1.0.0" },
};

function makeMeta(teamFlags: Record<string, unknown> = {}): Meta {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return {
    id: "019990c0-0000-7000-8000-000000000001",
    url: "https://www.linkedin.com/in/synthetic-person",
    logger,
    options: {},
    mock: null,
    abort: { asSignal: () => undefined },
    internalOptions: { teamId: "team-test", teamFlags },
  } as unknown as Meta;
}

describe("exchange engine", () => {
  beforeEach(() => {
    config.FIRE_EXCHANGE_URL = "https://exchange.example";
    vi.mocked(robustFetch).mockReset();
  });

  afterEach(() => {
    config.FIRE_EXCHANGE_URL = originalExchangeUrl;
  });

  it("forwards the organization's data source access and bills the reported price", async () => {
    vi.mocked(robustFetch).mockResolvedValue({
      success: true,
      accessEventId: "access-1",
      creditsCost: 30,
      data: {
        url: "https://www.linkedin.com/in/synthetic-person",
        title: "Synthetic Person",
        markdown: "# Synthetic Person",
        source: { provider: "firecrawl-enrich" },
      },
    });

    const result = await scrapeURLWithExchange(
      makeMeta({ organizationDataSourceAccess: access }),
    );

    expect(vi.mocked(robustFetch).mock.calls[0][0]).toMatchObject({
      url: "https://exchange.example/v1/scrape",
      body: { teamId: "team-test", organizationDataSourceAccess: access },
    });
    expect(result.exchange).toEqual({
      handled: true,
      creditsCost: 30,
      accessEventId: "access-1",
      integrationId: "firecrawl-enrich",
    });
  });

  it("omits access rows the team does not have", async () => {
    vi.mocked(robustFetch).mockResolvedValue({
      success: false,
      error: { code: "not_found" },
    });

    await expect(scrapeURLWithExchange(makeMeta())).rejects.toBeInstanceOf(
      EngineError,
    );
    expect(vi.mocked(robustFetch).mock.calls[0][0].body).not.toHaveProperty(
      "organizationDataSourceAccess",
    );
  });

  it.each(["enrichment_not_enabled", "enrichment_unavailable"])(
    "points %s at the enrichment settings",
    async code => {
      vi.mocked(robustFetch).mockResolvedValue({
        success: false,
        error: { code, message: "refused" },
      });

      const error = await scrapeURLWithExchange(makeMeta()).catch(e => e);

      expect(error).toBeInstanceOf(EnrichmentNotEnabledError);
      expect(error.code).toBe("SCRAPE_ENRICHMENT_NOT_ENABLED");
      expect(error.message).toContain(
        "https://www.firecrawl.dev/app/alexandria?enrichment=true",
      );
    },
  );

  it("names the provider terms to accept", async () => {
    vi.mocked(robustFetch).mockResolvedValue({
      success: false,
      error: {
        code: "third_party_data_terms_required",
        provider: "apollo",
        terms: { key: "apollo", version: "F-1.0.0" },
      },
    });

    const error = await scrapeURLWithExchange(makeMeta()).catch(e => e);

    expect(error).toBeInstanceOf(ThirdPartyDataTermsRequiredError);
    expect(error.code).toBe("THIRD_PARTY_DATA_TERMS_REQUIRED");
    expect(error.terms).toEqual({ key: "apollo", version: "F-1.0.0" });
    expect(error.message).toContain(
      "https://www.firecrawl.dev/app/alexandria/apollo",
    );
  });

  it("keeps other refusals generic", async () => {
    vi.mocked(robustFetch).mockResolvedValue({
      success: false,
      error: { code: "third_party_data_terms_required" },
    });

    await expect(scrapeURLWithExchange(makeMeta())).rejects.toBeInstanceOf(
      EngineError,
    );
  });
});
