import { collectDefaultMetrics, register } from "prom-client";

let started = false;

/**
 * Export the Node runtime's own health through the default registry, next to
 * the request histograms the app and the workers already serve.
 *
 * The interesting series are `nodejs_eventloop_lag_*_seconds` (sampled via
 * `perf_hooks.monitorEventLoopDelay`), the heap and GC series and the active
 * handle/request counts: a pod that stops answering its liveness probe while
 * its CPU, memory and descriptor counts look normal is otherwise invisible.
 *
 * Idempotent: `collectDefaultMetrics` throws when a metric name is registered
 * twice, and several entry points share this module. The flag is set only
 * after a successful registration so a failed attempt can be retried.
 */
export function startNodeRuntimeMetrics(): void {
  if (started) return;
  collectDefaultMetrics({ register });
  started = true;
}
