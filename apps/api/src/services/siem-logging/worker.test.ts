import { beforeEach, describe, expect, it, vi } from "vitest";

const { eventsTotal, failuresTotal } = vi.hoisted(() => ({
  eventsTotal: { inc: vi.fn() },
  failuresTotal: { inc: vi.fn() },
}));
vi.mock("../../lib/siem-logging/metrics", () => ({
  siemLoggingEventsTotal: eventsTotal,
  siemLoggingDeliveryFailuresTotal: failuresTotal,
  siemLoggingDeliveryBatchesTotal: { inc: vi.fn() },
}));

import {
  SiemDeliveryError,
  type OrgSiemLoggingConfig,
  type ScrapeActivityEvent,
} from "../../lib/siem-logging/types";
import { deliverSiemLoggingBatch } from "./worker";

function event(scrapeId: string): ScrapeActivityEvent {
  return {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: scrapeId,
    request_id: "request-id",
    endpoint: "scrape",
    team_id: "team-id",
    org_id: "org-id",
    api_key: { id: null, name: null },
    started_at: "2026-07-27T00:00:00.000Z",
    completed_at: "2026-07-27T00:00:01.000Z",
    url: "https://example.com",
    domain: "example.com",
    http_method: "GET",
    http_status: 200,
    result: "success",
    error: null,
    origin: "api",
    integration: null,
    zero_data_retention: false,
  };
}

const events = [event("scrape-1"), event("scrape-2")];

const config: OrgSiemLoggingConfig = {
  orgId: "org-id",
  enabled: true,
  destination: {
    type: "azure_sentinel",
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    dceUrl: "https://example.eastus.ingest.monitor.azure.com",
    dcrImmutableId: "dcr-id",
    streamName: "Custom-FirecrawlScrapeActivity",
  },
  createdAt: null,
  updatedAt: null,
};

describe("SIEM logging batch delivery", () => {
  beforeEach(() => {
    eventsTotal.inc.mockClear();
    failuresTotal.inc.mockClear();
  });

  it("counts only the events a partly-delivered batch actually landed", async () => {
    const error = new SiemDeliveryError("delivery_error", "chunk 2 failed");
    // Azure accepted the first chunk before the call blew up.
    error.deliveredEvents = 1;

    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver: vi.fn().mockRejectedValue(error),
    });

    expect(outcome).toEqual({
      disposition: "retry",
      retryAfterMs: undefined,
    });
    expect(eventsTotal.inc).toHaveBeenCalledWith({ result: "delivered" }, 1);
    expect(eventsTotal.inc).toHaveBeenCalledWith(
      { result: "delivery_failed" },
      1,
    );
    expect(failuresTotal.inc).toHaveBeenCalledWith(
      { reason: "delivery_error" },
      1,
    );
  });

  it("loads the current secret at delivery time and sends one batch", async () => {
    const deliver = vi.fn().mockResolvedValue(2);
    const getConfig = vi.fn().mockResolvedValue(config);

    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig,
      deliver,
    });

    expect(getConfig).toHaveBeenCalledWith("org-id");
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(config.destination, events);
    expect(outcome).toEqual({ disposition: "done" });
  });

  it("acks queued events after logging is disabled", async () => {
    const deliver = vi.fn();

    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig: vi.fn().mockResolvedValue({ ...config, enabled: false }),
      deliver,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(outcome).toEqual({ disposition: "done" });
  });

  it("retries when the configuration lookup fails", async () => {
    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig: vi.fn().mockRejectedValue(new Error("db down")),
      deliver: vi.fn(),
    });

    expect(outcome).toEqual({ disposition: "retry" });
  });

  it("retries transient delivery failures", async () => {
    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver: vi
        .fn()
        .mockRejectedValue(new SiemDeliveryError("delivery_error", "boom")),
    });

    expect(outcome).toEqual({
      disposition: "retry",
      retryAfterMs: undefined,
    });
  });

  it("surfaces the provider's Retry-After to the retry ladder", async () => {
    const outcome = await deliverSiemLoggingBatch("org-id", events, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver: vi
        .fn()
        .mockRejectedValue(
          new SiemDeliveryError("rate_limited", "retry", 429, 15_000),
        ),
    });

    expect(outcome).toEqual({ disposition: "retry", retryAfterMs: 15_000 });
  });

  it("dead-letters permanent destination failures", async () => {
    for (const kind of ["invalid_credentials", "schema_rejection"] as const) {
      const outcome = await deliverSiemLoggingBatch("org-id", events, {
        getConfig: vi.fn().mockResolvedValue(config),
        deliver: vi.fn().mockRejectedValue(new SiemDeliveryError(kind, kind)),
      });

      expect(outcome).toEqual({ disposition: "drop" });
    }
  });
});
