import {
  shouldSkipPersistenceForForcedZdr,
  shouldSkipPersistenceForJobZdr,
} from "./zdr-persistence";
import type { RequestWithAuth } from "../types";
import type { FeedbackJobRow, FeedbackRecordOptions } from "./internal-types";

function reqWithFlags(flags: Record<string, unknown>) {
  return {
    acuc: { flags },
  } as RequestWithAuth<any, any, any>;
}

function options(
  endpoint: FeedbackRecordOptions["endpoint"],
  overrides: Partial<FeedbackRecordOptions> = {},
): FeedbackRecordOptions {
  return {
    endpoint,
    jobId: "01933161-0000-7000-8000-000000000001",
    feedback: { rating: "bad", note: "bad result" },
    source: "feedback",
    ...overrides,
  };
}

function job(
  endpoint: FeedbackRecordOptions["endpoint"],
  jobOptions: unknown,
): FeedbackJobRow {
  return {
    endpoint,
    id: "01933161-0000-7000-8000-000000000001",
    request_id: "01933161-0000-7000-8000-000000000002",
    team_id: "01933161-0000-7000-8000-000000000003",
    credits_cost: 2,
    created_at: new Date().toISOString(),
    is_successful: true,
    options: jobOptions,
  };
}

describe("feedback ZDR persistence guards", () => {
  it("does not treat optional search ZDR as a forced persistence skip", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ searchZDR: "allowed" }),
        options("search"),
      ),
    ).toBe(false);
  });

  it("skips persistence for forced search ZDR modes", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ searchZDR: "forced-zdr" }),
        options("search"),
      ),
    ).toBe(true);

    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ searchZDR: "forced-anon" }),
        options("search"),
      ),
    ).toBe(true);
  });

  it("does not treat optional scrape ZDR as a forced persistence skip", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ scrapeZDR: "allowed" }),
        options("scrape"),
      ),
    ).toBe(false);
  });

  it("does not treat legacy optional ZDR as a forced persistence skip", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ allowZDR: true }),
        options("search"),
      ),
    ).toBe(false);

    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ allowZDR: true }),
        options("scrape"),
      ),
    ).toBe(false);
  });

  it("skips persistence for forced scrape and parse ZDR", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ scrapeZDR: "forced" }),
        options("scrape"),
      ),
    ).toBe(true);

    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ scrapeZDR: "forced" }),
        options("parse"),
      ),
    ).toBe(true);
  });

  it("skips persistence for legacy forced ZDR", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ forceZDR: true }),
        options("search"),
      ),
    ).toBe(true);

    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ forceZDR: true }),
        options("parse"),
      ),
    ).toBe(true);
  });

  it("does not skip map feedback for scrape ZDR flags", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ scrapeZDR: "forced" }),
        options("map"),
      ),
    ).toBe(false);
  });

  it("skips persistence for jobs logged with endpoint-level ZDR redaction", () => {
    expect(
      shouldSkipPersistenceForJobZdr(
        job("search", { enterprise: ["zdr"] }),
        options("search"),
      ),
    ).toBe(true);

    expect(
      shouldSkipPersistenceForJobZdr(job("scrape", null), options("scrape")),
    ).toBe(true);
  });

  it("allows persistence when the job row is not ZDR-redacted", () => {
    expect(
      shouldSkipPersistenceForJobZdr(
        job("search", { limit: 5 }),
        options("search"),
      ),
    ).toBe(false);

    expect(
      shouldSkipPersistenceForJobZdr(
        job("parse", { formats: ["markdown"] }),
        options("parse"),
      ),
    ).toBe(false);
  });

  it("honors explicit skipZdrPersistence override", () => {
    expect(
      shouldSkipPersistenceForForcedZdr(
        reqWithFlags({ searchZDR: "forced-zdr" }),
        options("search", { skipZdrPersistence: false }),
      ),
    ).toBe(false);

    expect(
      shouldSkipPersistenceForJobZdr(
        job("search", { enterprise: ["anon"] }),
        options("search", { skipZdrPersistence: false }),
      ),
    ).toBe(false);
  });
});
