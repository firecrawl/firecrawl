export { shutdownTracing } from "../otel";
export {
  SpanKind,
  isZeroDataRetentionActive,
  recordSpanException,
  serializeTraceContext,
  setSpanAttributes,
  withTraceContextAsync,
  withSpan,
  withZeroDataRetention,
  type Span,
} from "../lib/otel-tracer";
export {
  getRoutePattern,
  httpRequestDurationSeconds,
} from "../lib/http-metrics";
export { jobDurationSeconds } from "../lib/job-metrics";
export { startNodeRuntimeMetrics } from "../lib/node-runtime-metrics";
