/**
 * v2 batch scrape admits blocklisted URLs the Exchange can serve, the same
 * way single scrape does, and refuses the rest: with the terms error when
 * unaccepted terms are what keeps a URL out, with the unsupported-option
 * error when a request option does, else as an unsupported site.
 */

const mocks = vi.hoisted(() => ({
  isUrlBlocked: vi.fn((url: string) =>
    ["profiles.example", "blocked.example"].includes(new URL(url).hostname),
  ),
  exchangeRequest: vi.fn(),
  addScrapeJobs: vi.fn(),
  emitRejectedScrapeActivityEvents: vi.fn(),
}));

vi.mock(
  "../../../scraper/WebScraper/utils/blocklist",
  async importOriginal => ({
    ...(await importOriginal<
      typeof import("../../../scraper/WebScraper/utils/blocklist")
    >()),
    isUrlBlocked: mocks.isUrlBlocked,
  }),
);
vi.mock("../../../services/alexandria/client", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/alexandria/client")
  >()),
  exchangeRequest: mocks.exchangeRequest,
}));
vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/queue-jobs")>()),
  addScrapeJobs: mocks.addScrapeJobs,
}));
vi.mock("../../../lib/siem-logging", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/siem-logging")>()),
  emitRejectedScrapeActivityEvents: mocks.emitRejectedScrapeActivityEvents,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/crawl-redis")>()),
  saveCrawl: vi.fn(),
  markCrawlActive: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  lockURLs: vi.fn().mockResolvedValue(true),
  addCrawlJobs: vi.fn(),
}));
vi.mock("../../../services/worker/nuq-router", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/worker/nuq-router")
  >()),
  crawlGroup: { addGroup: vi.fn() },
  resolveNewGroupBackend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../services/logging/log_job", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/logging/log_job")
  >()),
  logRequest: vi.fn(),
}));

import { batchScrapeController } from "../../../controllers/v2/batch-scrape";
import { config } from "../../../config";
import {
  clearExchangeProvidersForTest,
  setExchangeProvidersForTest,
  ThirdPartyDataTermsRequiredError,
  ThirdPartyDataUnsupportedOptionError,
} from "../../../lib/exchange";
import { UnsupportedSiteError } from "../../../lib/error";
import { UNSUPPORTED_SITE_MESSAGE } from "../../../lib/strings";
import { buildFallbackList } from "../../../scraper/scrapeURL/engines";

describe("v2 batch scrape of blocklisted URLs", () => {
  const TERMS = { key: "acme", version: "2026-01-01" };
  const BLOCKED_URL = "https://profiles.example/person/example-person";
  const UNSERVED_URL = "https://blocked.example/person/example-person";
  const OPEN_URL = "https://open.example/page";

  const ACCEPTED_FLAGS = {
    organizationDataSourceAccess: {
      acme: {
        status: "enabled",
        termsKey: TERMS.key,
        termsVersion: TERMS.version,
      },
    },
  };
  const UNACCEPTED_FLAGS = {};

  const originalConfig = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    config.FIRE_EXCHANGE_URL = "http://test-exchange";
    // The ledger is unreachable: only the flags can show acceptance.
    mocks.exchangeRequest.mockRejectedValue(new Error("offline"));
    mocks.addScrapeJobs.mockReset();
    mocks.emitRejectedScrapeActivityEvents.mockReset();
    setExchangeProvidersForTest([
      {
        id: "acme",
        creditsCost: 12,
        terms: TERMS,
        routes: [{ domains: ["profiles.example"] }],
      },
    ]);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalConfig.USE_DB_AUTHENTICATION;
    config.FIRE_EXCHANGE_URL = originalConfig.FIRE_EXCHANGE_URL;
    clearExchangeProvidersForTest();
  });

  async function batchScrape(
    body: Record<string, unknown>,
    flags: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    let status = 200;
    let payload: any;
    const res: any = {
      headersSent: false,
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        payload = value;
        return res;
      },
    };
    await batchScrapeController(
      {
        body,
        headers: {},
        protocol: "http",
        host: "api.test",
        auth: { team_id: "team-1" },
        acuc: { flags, team_id: "team-1", org_id: "org-1" },
      } as any,
      res,
    );
    return { status, body: payload };
  }

  const enqueuedJobs = (): any[] => mocks.addScrapeJobs.mock.calls.flat(2);

  const rejectedEvents = (): any[] =>
    mocks.emitRejectedScrapeActivityEvents.mock.calls.flat(2);

  describe("without ignoreInvalidURLs", () => {
    it("admits a blocked URL the Exchange can serve and routes its job to the Exchange", async () => {
      const result = await batchScrape(
        { urls: [BLOCKED_URL, OPEN_URL], ignoreInvalidURLs: false },
        ACCEPTED_FLAGS,
      );

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(rejectedEvents()).toEqual([]);

      const jobs = enqueuedJobs();
      expect(jobs.map(job => job.data.url)).toEqual([BLOCKED_URL, OPEN_URL]);

      const blockedJob = jobs[0];
      const fallback = await buildFallbackList({
        id: blockedJob.jobId,
        url: blockedJob.data.url,
        options: blockedJob.data.scrapeOptions,
        internalOptions: blockedJob.data.internalOptions,
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
      } as any);
      expect(fallback.map(f => f.engine)).toEqual(["exchange"]);
    });

    it("asks for the terms when they keep a blocked URL out", async () => {
      const result = await batchScrape(
        { urls: [OPEN_URL, BLOCKED_URL], ignoreInvalidURLs: false },
        UNACCEPTED_FLAGS,
      );

      expect(result).toEqual({
        status: 403,
        body: new ThirdPartyDataTermsRequiredError(TERMS).response(),
      });
      expect(result.body.requiresAction).toMatchObject({
        type: "accept_terms",
        terms: TERMS.key,
        version: TERMS.version,
      });
      expect(enqueuedJobs()).toEqual([]);
      expect(rejectedEvents()).toEqual([
        expect.objectContaining({
          url: BLOCKED_URL,
          error: expect.any(ThirdPartyDataTermsRequiredError),
        }),
      ]);
    });

    it("names the option that keeps the provider out of a blocked URL", async () => {
      const result = await batchScrape(
        {
          urls: [OPEN_URL, BLOCKED_URL],
          ignoreInvalidURLs: false,
          redactPII: true,
        },
        ACCEPTED_FLAGS,
      );

      expect(result).toEqual({
        status: 400,
        body: new ThirdPartyDataUnsupportedOptionError(
          "`redactPII`",
        ).response(),
      });
      expect(result.body.code).toBe("THIRD_PARTY_DATA_UNSUPPORTED_OPTION");
      expect(enqueuedJobs()).toEqual([]);
      expect(rejectedEvents()).toEqual([
        expect.objectContaining({
          url: BLOCKED_URL,
          error: expect.any(ThirdPartyDataUnsupportedOptionError),
        }),
      ]);
    });

    it("rejects a blocked URL the Exchange cannot serve as an unsupported site", async () => {
      const result = await batchScrape(
        { urls: [OPEN_URL, UNSERVED_URL], ignoreInvalidURLs: false },
        ACCEPTED_FLAGS,
      );

      expect(result).toEqual({
        status: 403,
        body: { success: false, error: UNSUPPORTED_SITE_MESSAGE },
      });
      expect(enqueuedJobs()).toEqual([]);
      expect(rejectedEvents()).toEqual([
        expect.objectContaining({
          url: UNSERVED_URL,
          error: expect.any(UnsupportedSiteError),
        }),
      ]);
    });
  });

  describe("with ignoreInvalidURLs", () => {
    it("admits Exchange-served blocked URLs and lists the rest as invalid", async () => {
      const result = await batchScrape(
        { urls: [BLOCKED_URL, UNSERVED_URL, OPEN_URL] },
        ACCEPTED_FLAGS,
      );

      expect(result.status).toBe(200);
      expect(result.body.invalidURLs).toEqual([UNSERVED_URL]);
      expect(enqueuedJobs().map(job => job.data.url)).toEqual([
        BLOCKED_URL,
        OPEN_URL,
      ]);
      expect(rejectedEvents()).toEqual([
        expect.objectContaining({
          url: UNSERVED_URL,
          error: expect.any(UnsupportedSiteError),
        }),
      ]);
    });

    it("lists a blocked URL whose terms are unaccepted as invalid", async () => {
      const result = await batchScrape(
        { urls: [BLOCKED_URL, OPEN_URL], ignoreInvalidURLs: true },
        UNACCEPTED_FLAGS,
      );

      expect(result.status).toBe(200);
      expect(result.body.invalidURLs).toEqual([BLOCKED_URL]);
      expect(enqueuedJobs().map(job => job.data.url)).toEqual([OPEN_URL]);
      expect(rejectedEvents()).toEqual([
        expect.objectContaining({
          url: BLOCKED_URL,
          error: expect.any(ThirdPartyDataTermsRequiredError),
        }),
      ]);
    });
  });
});
