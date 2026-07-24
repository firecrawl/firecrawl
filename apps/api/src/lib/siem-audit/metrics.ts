import { Counter, Gauge } from "prom-client";

export const siemAuditEventsTotal = new Counter({
  name: "firecrawl_siem_audit_events_total",
  help: "Scrape activity events accepted or dropped by the SIEM buffer",
  labelNames: ["result"] as const,
});

export const siemAuditDeliveryBatchesTotal = new Counter({
  name: "firecrawl_siem_audit_delivery_batches_total",
  help: "SIEM delivery batches by outcome",
  labelNames: ["result"] as const,
});

export const siemAuditDeliveryFailuresTotal = new Counter({
  name: "firecrawl_siem_audit_delivery_failures_total",
  help: "SIEM delivery failures by normalized reason",
  labelNames: ["reason"] as const,
});

export const siemAuditBufferedEvents = new Gauge({
  name: "firecrawl_siem_audit_buffered_events",
  help: "Scrape activity events currently held in process memory",
});
