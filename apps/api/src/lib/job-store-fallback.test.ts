import { describe, expect, it, vi } from "vitest";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info } }));

import {
  jobStorePostgresFallbackTotal,
  recordJobStorePostgresFallback,
} from "./job-store-fallback";

describe("job store fallback accounting", () => {
  it("counts and logs one hit per store", async () => {
    recordJobStorePostgresFallback("scrape_state", "job-1");
    recordJobStorePostgresFallback("scrape_state", "job-2");
    recordJobStorePostgresFallback("job_access", "job-3", { kind: "crawl" });

    const metric = await jobStorePostgresFallbackTotal.get();
    const byStore = Object.fromEntries(
      metric.values.map(v => [v.labels.store, v.value]),
    );
    expect(byStore).toMatchObject({ scrape_state: 2, job_access: 1 });

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
});
