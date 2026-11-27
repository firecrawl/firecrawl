import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroupJobs: vi.fn(),
  smembers: vi.fn(),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  getCrawlRobotsBlocked: mocks.smembers,
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  scrapeQueue: { getGroupJobs: mocks.getGroupJobs },
}));

import { RacedRedirectError } from "../../../lib/error";
import {
  coreErrors,
  serializeTransportableError,
} from "../../../lib/error-serde";
import { SiteError } from "../../../scraper/scrapeURL/error";
import { createService, replaceService } from "../../../service/service";
import { crawlErrorsController as v2CrawlErrorsController } from "../crawl-errors";

// What is read back from a job is rebuilt by the class the service has for its
// code.
const withCoreErrors = createService(
  { modules: {} },
  { core: { name: "core", errors: coreErrors }, logger: { error: vi.fn() } },
);
beforeAll(() => {
  replaceService(withCoreErrors);
});
afterAll(() => {
  replaceService(undefined);
});

describe.each([["v2", v2CrawlErrorsController]])(
  "%s crawl errors",
  (_version, crawlErrorsController) => {
    const siteError = new SiteError("ERR_CONNECTION_RESET");
    const truncated = serializeTransportableError(siteError).slice(0, 60);

    beforeEach(() => {
      mocks.getCrawl.mockResolvedValue({ team_id: "team-1" });
      mocks.smembers.mockResolvedValue([]);
      mocks.getGroupJobs.mockResolvedValue([
        {
          id: "job-known",
          data: { url: "https://down.example/" },
          failedReason: serializeTransportableError(siteError),
        },
        {
          id: "job-no-class",
          data: { url: "https://newer.example/" },
          failedReason: `SCRAPE_FROM_ANOTHER_BUILD|${JSON.stringify({
            stack: "Error: Not known here\n    at worker",
            message: "Not known here",
          })}`,
        },
        {
          id: "job-plain",
          data: { url: "https://plain.example/" },
          failedReason: "Job stalled",
        },
        {
          id: "job-truncated",
          data: { url: "https://truncated.example/" },
          failedReason: truncated,
        },
        {
          id: "job-raced",
          data: { url: "https://raced.example/" },
          failedReason: serializeTransportableError(new RacedRedirectError()),
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

    it("lists a code with a class by its code and message", async () => {
      const { errors } = await listErrors();

      expect(errors.find((e: any) => e.id === "job-known")).toEqual({
        id: "job-known",
        url: "https://down.example/",
        code: "SCRAPE_SITE_ERROR",
        error: siteError.message,
      });
    });

    it("lists a code with no class by its code and message", async () => {
      const { errors } = await listErrors();

      expect(errors.find((e: any) => e.id === "job-no-class")).toEqual({
        id: "job-no-class",
        url: "https://newer.example/",
        code: "SCRAPE_FROM_ANOTHER_BUILD",
        error: "Not known here",
      });
    });

    it("lists a reason that is not a serialized error as it is", async () => {
      const { errors } = await listErrors();
      const plain = errors.find((e: any) => e.id === "job-plain");

      expect(plain).toEqual({
        id: "job-plain",
        url: "https://plain.example/",
        error: "Job stalled",
      });
      expect(plain).not.toHaveProperty("code");
    });

    it("lists a serialized error that was cut short as it is", async () => {
      const { errors } = await listErrors();

      expect(errors.find((e: any) => e.id === "job-truncated")).toEqual({
        id: "job-truncated",
        url: "https://truncated.example/",
        error: truncated,
      });
    });

    it("leaves raced redirects out", async () => {
      const { errors } = await listErrors();

      expect(errors.map((e: any) => e.id)).toEqual([
        "job-known",
        "job-no-class",
        "job-plain",
        "job-truncated",
      ]);
    });
  },
);
