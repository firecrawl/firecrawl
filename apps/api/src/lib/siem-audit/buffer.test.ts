import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSiemAuditBuffers,
  enqueueForSiemDelivery,
  SiemAuditBuffer,
} from "./buffer";
import type { AzureSentinelDestination, ScrapeActivityEvent } from "./types";
import { config } from "../../config";

const destination: AzureSentinelDestination = {
  type: "azure_sentinel",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  dceUrl: "https://example.eastus.ingest.monitor.azure.com",
  dcrImmutableId: "dcr-id",
  streamName: "Custom-FirecrawlScrapeActivity",
};

function event(id: string): ScrapeActivityEvent {
  return {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: id,
    request_id: "request-id",
    endpoint: "scrape",
    team_id: "team-id",
    org_id: "org-id",
    api_key: { id: null, name: null },
    audit_metadata: {},
    started_at: "2026-07-24T00:00:00.000Z",
    completed_at: "2026-07-24T00:00:01.000Z",
    url: "https://example.com",
    domain: "example.com",
    http_method: "GET",
    http_status: 200,
    result: "success",
    error: null,
    origin: "api",
    integration: null,
    zero_data_retention: true,
  };
}

const originalBufferMax = config.SIEM_AUDIT_BUFFER_MAX_EVENTS;
const originalBatchMax = config.SIEM_AUDIT_BATCH_MAX_EVENTS;
const originalFlushInterval = config.SIEM_AUDIT_FLUSH_INTERVAL_MS;

afterEach(() => {
  clearSiemAuditBuffers();
  config.SIEM_AUDIT_BUFFER_MAX_EVENTS = originalBufferMax;
  config.SIEM_AUDIT_BATCH_MAX_EVENTS = originalBatchMax;
  config.SIEM_AUDIT_FLUSH_INTERVAL_MS = originalFlushInterval;
});

describe("SiemAuditBuffer", () => {
  it("flushes a full batch without waiting for the timer", async () => {
    const deliver = vi.fn(async () => {});
    const buffer = new SiemAuditBuffer(destination, deliver, 10, 2, 60_000);

    expect(buffer.enqueue(event("one"))).toBe(true);
    expect(buffer.enqueue(event("two"))).toBe(true);
    await buffer.flush();

    expect(deliver).toHaveBeenCalledWith(destination, [
      event("one"),
      event("two"),
    ]);
  });

  it("drops new events when the bounded buffer is full", () => {
    const buffer = new SiemAuditBuffer(
      destination,
      async () => {},
      1,
      10,
      60_000,
    );

    expect(buffer.enqueue(event("one"))).toBe(true);
    expect(buffer.enqueue(event("two"))).toBe(false);
  });

  it("does not retain failed batches in memory", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("destination unavailable");
    });
    const buffer = new SiemAuditBuffer(destination, deliver, 1, 1, 60_000);

    expect(buffer.enqueue(event("one"))).toBe(true);
    await buffer.flush();
    expect(buffer.enqueue(event("two"))).toBe(true);
  });

  it("enforces a process-wide event ceiling across organizations", () => {
    config.SIEM_AUDIT_BUFFER_MAX_EVENTS = 1;
    config.SIEM_AUDIT_BATCH_MAX_EVENTS = 10;
    config.SIEM_AUDIT_FLUSH_INTERVAL_MS = 60_000;

    expect(enqueueForSiemDelivery("org-one", destination, event("one"))).toBe(
      true,
    );
    expect(enqueueForSiemDelivery("org-two", destination, event("two"))).toBe(
      false,
    );
  });
});
