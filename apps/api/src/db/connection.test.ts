import { getDbPoolMetrics } from "./connection";

describe("getDbPoolMetrics", () => {
  it("emits the four pool gauge families in Prometheus text format", () => {
    const out = getDbPoolMetrics();
    for (const metric of [
      "db_pool_waiting_count",
      "db_pool_idle_count",
      "db_pool_total_count",
      "db_pool_max_count",
    ]) {
      expect(out).toContain(`# HELP ${metric} `);
      expect(out).toContain(`# TYPE ${metric} gauge`);
    }
    // Every sample line must carry the application_name label and a number.
    const samples = out.split("\n").filter(l => l.startsWith("db_pool_"));
    for (const s of samples) {
      expect(s).toMatch(/^db_pool_\w+\{application_name="[^"]+"\} \d+$/);
    }
  });
});
