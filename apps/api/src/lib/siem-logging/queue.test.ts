import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeActivityEvent } from "./types";

const mocks = vi.hoisted(() => ({
  addBulk: vi.fn().mockResolvedValue([]),
  inc: vi.fn(),
}));

vi.mock("../../services/queue-service", () => ({
  getSiemLoggingQueue: () => ({ addBulk: mocks.addBulk }),
}));

vi.mock("./metrics", () => ({
  siemLoggingEventsTotal: { inc: mocks.inc },
}));

import { enqueueSiemLoggingEvent } from "./queue";

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

describe("SIEM logging queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates repeat terminal events regardless of completion time", async () => {
    await enqueueSiemLoggingEvent("org-id", event);
    await enqueueSiemLoggingEvent("org-id", {
      ...event,
      completed_at: "2026-07-27T00:01:00.000Z",
    });

    const firstJobId = mocks.addBulk.mock.calls[0][0][0].opts.jobId;
    const secondJobId = mocks.addBulk.mock.calls[1][0][0].opts.jobId;
    expect(firstJobId).toBe(secondJobId);
  });
});
