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
  it("keeps the partner's token on the monitor row", async () => {
    expect((await create("job-token-abc")).partner_job_token).toBe(
      "job-token-abc",
    );
  });

  // Omitted, not null: a deploy ahead of the migration must still create
  // ordinary monitors.
  it("omits the key entirely when nobody sent one", async () => {
    expect(await create(null)).not.toHaveProperty("partner_job_token");
    expect(await create(undefined)).not.toHaveProperty("partner_job_token");
  });
});
