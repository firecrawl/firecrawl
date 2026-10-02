import { register } from "prom-client";
import { startNodeRuntimeMetrics } from "./node-runtime-metrics";

describe("startNodeRuntimeMetrics", () => {
  it("registers the event-loop, heap and GC series once", async () => {
    startNodeRuntimeMetrics();
    // A second call must not throw on the already-registered names.
    startNodeRuntimeMetrics();

    const names = (await register.getMetricsAsJSON()).map(m => m.name);
    for (const expected of [
      "nodejs_eventloop_lag_seconds",
      "nodejs_eventloop_lag_p99_seconds",
      "nodejs_eventloop_lag_max_seconds",
      "nodejs_heap_size_used_bytes",
      "nodejs_gc_duration_seconds",
      "nodejs_active_handles_total",
      "process_cpu_seconds_total",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
