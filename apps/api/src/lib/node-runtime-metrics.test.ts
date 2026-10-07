import { register } from "prom-client";
import { startNodeRuntimeMetrics } from "./node-runtime-metrics";

describe("startNodeRuntimeMetrics", () => {
  it("registers the event-loop, heap and GC series once, with live values", async () => {
    startNodeRuntimeMetrics();
    // A second call must not throw on the already-registered names.
    startNodeRuntimeMetrics();

    const metrics = await register.getMetricsAsJSON();
    const names = metrics.map(m => m.name);
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

    // Registered but empty would be invisible in production too: the gauges
    // that sample on collection must carry a value right away.
    for (const sampled of [
      "nodejs_heap_size_used_bytes",
      "process_cpu_seconds_total",
      "process_resident_memory_bytes",
    ]) {
      const metric = metrics.find(m => m.name === sampled);
      expect(metric?.values.length).toBeGreaterThan(0);
      expect(metric?.values[0].value).toBeGreaterThan(0);
    }
  });
});
