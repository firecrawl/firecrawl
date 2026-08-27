const { insertValues, insertMock } = vi.hoisted(() => {
  const insertValues: Record<string, unknown>[] = [];
  const insertMock = vi.fn(() => ({
    values: (row: Record<string, unknown>) => {
      insertValues.push(row);
      return { returning: async () => [row] };
    },
  }));
  return { insertValues, insertMock };
});

vi.mock("../../db/connection", () => ({
  db: { insert: insertMock },
  dbRr: { select: vi.fn() },
}));

vi.mock("../../db/rpc", () => ({ monitoringClaimDueMonitors: vi.fn() }));

import { createMonitor } from "./store";
import type { CreateMonitorRequest } from "./types";

const input = {
  name: "docs",
  schedule: { cron: "0 * * * *", timezone: "UTC" },
  retentionDays: 30,
  targets: [{ type: "scrape", urls: ["https://example.com"] }],
} as unknown as CreateMonitorRequest;

async function create(partnerJobToken?: string | null) {
  insertValues.length = 0;
  await createMonitor({
    teamId: "11111111-1111-1111-1111-111111111111",
    input,
    nextRunAt: new Date("2026-09-01T00:00:00.000Z"),
    intervalMs: 3_600_000,
    partnerJobToken,
  });
  return insertValues[0];
}

describe("createMonitor and the partner job token", () => {
  // A scheduled run writes no `requests` row — the runner wakes on
  // `next_run_at`, so nothing calls logRequest — which is the whole reason
  // the token has to be kept here instead of found again at billing time.
  it("keeps the partner's token on the monitor row", async () => {
    expect((await create("job-token-abc")).partner_job_token).toBe(
      "job-token-abc",
    );
  });

  // Stored for every monitor, gateway or not: conditioning the write would
  // mean a partner-provisioning lookup on the create path to save a NULL.
  it("writes null rather than nothing when nobody sent one", async () => {
    expect((await create(null)).partner_job_token).toBeNull();
    expect((await create(undefined)).partner_job_token).toBeNull();
  });
});
