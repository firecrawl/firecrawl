import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { config } from "./config";
import { logger } from "./lib/logger";
import { createTracerProvider } from "./lib/otel-tracer";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Imported for its side effects by every entry point, before anything that
// starts spans. Tracing stays off unless an OTLP endpoint is configured, in
// which case spans go to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
// `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces` over http/protobuf. The exporter
// reads the standard `OTEL_EXPORTER_OTLP_*` variables (headers, timeout,
// compression) itself.
const endpoint =
  config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  config.OTEL_EXPORTER_OTLP_ENDPOINT;

let provider: NodeTracerProvider | undefined;

if (endpoint) {
  const otelLogger = logger.child({ module: "otel" });
  const diagLogger: DiagLogger = {
    error: (message, ...args) => otelLogger.error(message, { args }),
    warn: (message, ...args) => otelLogger.warn(message, { args }),
    info: (message, ...args) => otelLogger.info(message, { args }),
    debug: (message, ...args) => otelLogger.debug(message, { args }),
    verbose: (message, ...args) => otelLogger.debug(message, { args }),
  };
  diag.setLogger(diagLogger, DiagLogLevel.WARN);

  const serviceName = config.OTEL_SERVICE_NAME ?? "firecrawl-api";
  provider = createTracerProvider({
    exporter: new OTLPTraceExporter(),
    serviceName,
    serviceInstanceId: config.NUQ_POD_NAME,
  });
  provider.register();

  otelLogger.info("OpenTelemetry tracing enabled", { endpoint, serviceName });
}

/**
 * Flushes buffered spans and stops the exporter. Bounded so a stuck collector
 * cannot hold up process shutdown.
 */
export async function shutdownTracing(timeoutMs = 5000): Promise<void> {
  if (!provider) {
    return;
  }

  const active = provider;
  provider = undefined;
  await Promise.race([
    active.shutdown().catch(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref()),
  ]);
}
