import { Counter } from "prom-client";

export const siemLoggingEventsTotal = new Counter({
  name: "firecrawl_siem_logging_events_total",
  help: "SIEM logging event lifecycle outcomes",
  labelNames: ["result"] as const,
});

export const siemLoggingDeliveryBatchesTotal = new Counter({
  name: "firecrawl_siem_logging_delivery_batches_total",
  help: "SIEM delivery batches by outcome",
  labelNames: ["result"] as const,
});

export const siemLoggingDeliveryFailuresTotal = new Counter({
  name: "firecrawl_siem_logging_delivery_failures_total",
  help: "SIEM delivery failures by normalized reason",
  labelNames: ["reason"] as const,
});
