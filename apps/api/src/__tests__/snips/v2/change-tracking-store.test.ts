import { Bigtable } from "@google-cloud/bigtable";

// Guards the primary scrape-logging path: log_job imports
// change-tracking-store at module load, which lazily loads
// @google-cloud/bigtable. Both imports must succeed even when Bigtable is
// not configured, and the bigtable package must load under the OTel 2.x
// dependency overrides (GHSA-8988-4f7v-96qf) even though its metrics
// chain was authored against OTel 1.x -- the metrics handler is disabled
// (metricsEnabled: false) at construction, which is where the 1.x-only
// symbols would otherwise throw.
describe("Change tracking store", () => {
  it.concurrent(
    "store module imports without Bigtable configured",
    async () => {
      const store = await import("../../../lib/change-tracking-store.js");
      expect(typeof store.changeTrackingInsertScrape).toBe("function");
      expect(typeof store.changeTrackingGetLastScrape).toBe("function");
    },
  );

  it.concurrent(
    "@google-cloud/bigtable loads under the OTel 2.x overrides",
    async () => {
      expect(Bigtable).toBeDefined();
    },
  );

  it.concurrent(
    "bigtable client constructs with the metrics handler disabled",
    () => {
      const bt = new Bigtable({
        projectId: "change-tracking-store-smoke",
        metricsEnabled: false,
      });
      expect(bt).toBeDefined();
    },
  );
});
