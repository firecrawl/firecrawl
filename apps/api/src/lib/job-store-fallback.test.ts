import { beforeEach, describe, expect, it, vi } from "vitest";

const { info, mutableConfig } = vi.hoisted(() => ({
  info: vi.fn(),
  mutableConfig: {
    BIGTABLE_JOB_ACCESS_TABLE: "api_job_access" as string | undefined,
    BIGTABLE_SCRAPE_STATE_TABLE: "scrape_state" as string | undefined,
    BIGTABLE_EXTRACT_STATE_TABLE: "extract_state" as string | undefined,
    BIGTABLE_FEEDBACK_JOBS_TABLE: "feedback_jobs" as string | undefined,
    BIGTABLE_REQUEST_CREDITS_TABLE: "request_credits" as string | undefined,
    BIGTABLE_CHANGE_TRACKING_TABLE: "change_tracking" as string | undefined,
  },
}));
vi.mock("./logger", () => ({ logger: { info } }));
vi.mock("../config", () => ({ config: mutableConfig }));

import {
  jobStorePostgresFallbackTotal,
  recordJobStorePostgresFallback,
} from "./job-store-fallback";

async function countsByStore() {
  const metric = await jobStorePostgresFallbackTotal.get();
  return Object.fromEntries(metric.values.map(v => [v.labels.store, v.value]));
}

describe("job store fallback accounting", () => {
  beforeEach(() => {
    jobStorePostgresFallbackTotal.reset();
    info.mockClear();
    mutableConfig.BIGTABLE_SCRAPE_STATE_TABLE = "scrape_state";
  });

  it("counts and logs one hit per store", async () => {
    recordJobStorePostgresFallback("scrape_state", "job-1");
    recordJobStorePostgresFallback("scrape_state", "job-2");
    recordJobStorePostgresFallback("job_access", "job-3", { kind: "crawl" });

    expect(await countsByStore()).toMatchObject({
      scrape_state: 2,
      job_access: 1,
    });

    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenLastCalledWith(
      "PostgreSQL fallback served a job-store read",
      expect.objectContaining({
        store: "job_access",
        id: "job-3",
        kind: "crawl",
      }),
    );
  });

  it("lets the fixed log fields win over extra context", () => {
    recordJobStorePostgresFallback("scrape_state", "job-1", {
      id: "spoofed",
      store: "spoofed",
      module: "spoofed",
    });

    expect(info).toHaveBeenCalledWith(
      "PostgreSQL fallback served a job-store read",
      expect.objectContaining({
        module: "job-store-fallback",
        store: "scrape_state",
        id: "job-1",
      }),
    );
  });

  it("records nothing when the store is not configured", async () => {
    mutableConfig.BIGTABLE_SCRAPE_STATE_TABLE = undefined;

    recordJobStorePostgresFallback("scrape_state", "job-1");

    expect(await countsByStore()).toEqual({});
    expect(info).not.toHaveBeenCalled();
  });
});
