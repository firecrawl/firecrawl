import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  SiemDeliveryError,
  type OrgSiemLoggingConfig,
  type ScrapeActivityEvent,
  type SiemLoggingJobData,
} from "../../lib/siem-logging/types";
import { processSiemLoggingJob } from "./worker";

const event: ScrapeActivityEvent = {
  schema_version: 1,
  event_type: "scrape_activity",
  scrape_id: "scrape-id",
  request_id: "request-id",
  endpoint: "scrape",
  team_id: "team-id",
  org_id: "org-id",
  api_key: { id: null, name: null },
  audit_metadata: {},
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

function createJob() {
  return {
    id: "job-id",
    data: { orgId: "org-id", event },
    extendLock: vi.fn().mockResolvedValue(1),
    moveToCompleted: vi.fn().mockResolvedValue(undefined),
    moveToFailed: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn(),
  } as unknown as Job<SiemLoggingJobData>;
}

describe("SIEM logging worker", () => {
  it("loads the current secret at delivery time and completes the job", async () => {
    const job = createJob();
    const deliver = vi.fn().mockResolvedValue(undefined);

    await processSiemLoggingJob("token", job, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver,
    });

    expect(deliver).toHaveBeenCalledWith(config.destination, [event]);
    expect(job.moveToCompleted).toHaveBeenCalledWith(
      { delivered: true },
      "token",
      false,
    );
    expect(job.moveToFailed).not.toHaveBeenCalled();
  });

  it("skips queued events after logging is disabled", async () => {
    const job = createJob();
    const deliver = vi.fn();

    await processSiemLoggingJob("token", job, {
      getConfig: vi.fn().mockResolvedValue({ ...config, enabled: false }),
      deliver,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(job.moveToCompleted).toHaveBeenCalledWith(
      { skipped: true },
      "token",
      false,
    );
  });

  it("leaves transient delivery failures retryable", async () => {
    const job = createJob();

    await processSiemLoggingJob("token", job, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver: vi
        .fn()
        .mockRejectedValue(new SiemDeliveryError("rate_limited", "retry")),
    });

    expect(job.discard).not.toHaveBeenCalled();
    expect(job.moveToFailed).toHaveBeenCalledOnce();
  });

  it("discards permanent destination failures", async () => {
    const job = createJob();

    await processSiemLoggingJob("token", job, {
      getConfig: vi.fn().mockResolvedValue(config),
      deliver: vi
        .fn()
        .mockRejectedValue(
          new SiemDeliveryError("invalid_credentials", "invalid"),
        ),
    });

    expect(job.discard).toHaveBeenCalledOnce();
    expect(job.moveToFailed).toHaveBeenCalledOnce();
  });
});
