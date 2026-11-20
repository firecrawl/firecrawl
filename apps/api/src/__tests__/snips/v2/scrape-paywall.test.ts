import { randomUUID } from "node:crypto";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import type { ResolvedSafeMode } from "../../../lib/safe-mode";
import { scrapeURL } from "../../../scraper/scrapeURL";
import * as engines from "../../../scraper/scrapeURL/engines";
import { PaywalledContentError } from "../../../scraper/scrapeURL/error";
import { scrapeTimeout } from "./lib";

const URL_UNDER_TEST = "https://example.com/article";

const paywalledHtml = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"NewsArticle","isAccessibleForFree":"False"}
</script></head><body><p>Full article body</p></body></html>`;

const openHtml = paywalledHtml.replace('"False"', '"True"');

const relaxedSafeMode = (respectPaywalls: boolean): ResolvedSafeMode => ({
  lockdown: false,
  domainControls: false,
  enforceRobots: false,
  disableStealthProxy: false,
  disableAuthentication: false,
  disableSiteHandling: false,
  exposeWebdriver: false,
  useHeadlessUserAgent: false,
  disablePlatformSelection: false,
  disableCountrySelection: false,
  disableAutomaticReferrer: false,
  respectPaywalls,
});

describe("Safe Mode respectPaywalls", () => {
  beforeEach(() => {
    vi.spyOn(engines, "scrapeURLWithEngine");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runScrape = (html: string, safeMode?: ResolvedSafeMode) => {
    vi.mocked(engines.scrapeURLWithEngine).mockResolvedValue({
      url: URL_UNDER_TEST,
      html,
      statusCode: 200,
      contentType: "text/html",
      proxyUsed: "basic",
    });
    return scrapeURL(
      randomUUID(),
      URL_UNDER_TEST,
      scrapeOptions.parse({ formats: ["rawHtml"], maxAge: 0 }),
      { teamId: "paywall-test", orgId: null, forceEngine: "fetch", safeMode },
      new CostTracking(),
    );
  };

  it(
    "refuses a paywalled page when the toggle is on",
    async () => {
      const result = await runScrape(paywalledHtml, relaxedSafeMode(true));

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected a paywall refusal");
      expect(result.error).toBeInstanceOf(PaywalledContentError);
    },
    scrapeTimeout,
  );

  it(
    "returns a paywalled page when the toggle is off",
    async () => {
      const result = await runScrape(paywalledHtml, relaxedSafeMode(false));

      expect(result.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "returns a paywalled page when Safe Mode is not active",
    async () => {
      const result = await runScrape(paywalledHtml);

      expect(result.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "returns an accessible page when the toggle is on",
    async () => {
      const result = await runScrape(openHtml, relaxedSafeMode(true));

      expect(result.success).toBe(true);
    },
    scrapeTimeout,
  );
});
