/**
 * Unit test for the crawl/batch errors listing: a page that failed on
 * unaccepted provider terms carries the same `requiresAction` a single
 * scrape's 403 body does, on v1 and v2.
 */

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroupJobs: vi.fn(),
  smembers: vi.fn(),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  scrapeQueue: { getGroupJobs: mocks.getGroupJobs },
}));
vi.mock("../../../services/redis", () => ({
  redisEvictConnection: { smembers: mocks.smembers },
}));

import { crawlErrorsController as v1CrawlErrorsController } from "../../../controllers/v1/crawl-errors";
import { crawlErrorsController as v2CrawlErrorsController } from "../../../controllers/v2/crawl-errors";
import { ThirdPartyDataTermsRequiredError } from "../../../lib/exchange";
import { serializeTransportableError } from "../../../lib/error-serde";
import { SiteError } from "../../../scraper/scrapeURL/error";

describe.each([
  ["v1", v1CrawlErrorsController],
  ["v2", v2CrawlErrorsController],
])("%s crawl errors", (_version, crawlErrorsController) => {
  const TERMS = { key: "acme", version: "2026-01-01" };

  beforeEach(() => {
    mocks.getCrawl.mockResolvedValue({ team_id: "team-1" });
    mocks.smembers.mockResolvedValue([]);
    mocks.getGroupJobs.mockResolvedValue([
      {
        id: "job-terms",
        data: { url: "https://profiles.example/person/example-person" },
        failedReason: serializeTransportableError(
          new ThirdPartyDataTermsRequiredError(TERMS),
        ),
      },
      {
        id: "job-site",
        data: { url: "https://down.example/" },
        failedReason: serializeTransportableError(
          new SiteError("ERR_CONNECTION_RESET"),
        ),
      },
    ]);
  });

  async function listErrors() {
    let body: any;
    const res: any = {
      status: () => res,
      json: (payload: unknown) => {
        body = payload;
        return res;
      },
    };
    await crawlErrorsController(
      {
        params: { jobId: "crawl-1" },
        auth: { team_id: "team-1" },
      } as any,
      res,
    );
    return body;
  }

  it("carries requiresAction on terms-required entries only", async () => {
    const { errors } = await listErrors();
    const expected = new ThirdPartyDataTermsRequiredError(TERMS).response();

    expect(errors.find((e: any) => e.id === "job-terms")).toMatchObject({
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      error: expected.error,
      requiresAction: expected.requiresAction,
    });
    expect(errors.find((e: any) => e.id === "job-site")).not.toHaveProperty(
      "requiresAction",
    );
  });
});
