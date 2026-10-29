import { PgDialect } from "drizzle-orm/pg-core";

const { select, replicaSelect, where, insert, values } = vi.hoisted(() => {
  const where = vi.fn();
  const select = vi.fn(() => ({ from: () => ({ where }) }));
  const replicaSelect = vi.fn(() => ({
    from: () => ({ where: async () => [] }),
  }));
  const values = vi.fn((row: Record<string, unknown>) => ({
    returning: async () => [row],
  }));
  const insert = vi.fn(() => ({ values }));
  return { select, replicaSelect, where, insert, values };
});

vi.mock("../../db/connection", () => ({
  db: { select, insert },
  dbRr: { select: replicaSelect },
}));
vi.mock("../../db/rpc", () => ({ monitoringClaimDueMonitors: vi.fn() }));

import { createMonitorCheck } from "./store";
import type { MonitorRow } from "./types";

const monitor = {
  id: "22222222-2222-4222-8222-222222222222",
  team_id: "11111111-1111-4111-8111-111111111111",
  targets: [
    {
      id: "pdf-target",
      type: "scrape",
      urls: ["https://example.com/report.pdf"],
    },
  ],
  goal: "Watch for changes",
  judge_enabled: true,
} as MonitorRow;

beforeEach(() => {
  vi.clearAllMocks();
  where.mockResolvedValue([]);
});

describe("monitor check credit reservation", () => {
  it("reserves primary PDF history even when the replica has not received it", async () => {
    where.mockResolvedValue([
      {
        target_id: "pdf-target",
        url: "https://example.com/report.pdf",
        metadata: { numPages: 100, creditsUsed: 1 },
      },
    ]);
    const check = await createMonitorCheck({ monitor, trigger: "scheduled" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(replicaSelect).not.toHaveBeenCalled();
    expect(check.estimated_credits).toBe(101);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor_id: monitor.id,
        estimated_credits: 101,
      }),
    );

    // Successful, active pages from this monitor/team/current target only.
    const predicate = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"monitor_pages"."monitor_id" =');
    expect(predicate.sql).toContain('"monitor_pages"."team_id" =');
    expect(predicate.sql).toContain('"monitor_pages"."is_removed" =');
    expect(predicate.sql).toContain('"monitor_pages"."last_status" in');
    expect(predicate.params).toEqual([
      monitor.id,
      monitor.team_id,
      "pdf-target",
      false,
      "new",
      "changed",
      "same",
    ]);
  });

  it("uses the ordinary estimate on a first run with no saved pages", async () => {
    const check = await createMonitorCheck({ monitor, trigger: "manual" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(replicaSelect).not.toHaveBeenCalled();
    expect(check.estimated_credits).toBe(2);
  });

  it("does not start a check with an understated estimate when history cannot be read", async () => {
    where.mockRejectedValue(new Error("database unavailable"));
    await expect(
      createMonitorCheck({ monitor, trigger: "scheduled" }),
    ).rejects.toThrow(
      "Failed to read previous monitor pages for credit reservation",
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not read PDF history when parsing is disabled", async () => {
    const unparsed = {
      ...monitor,
      targets: [
        {
          ...monitor.targets[0],
          scrapeOptions: { parsers: [] },
        },
      ],
    } as MonitorRow;
    expect(
      (await createMonitorCheck({ monitor: unparsed, trigger: "manual" }))
        .estimated_credits,
    ).toBe(2);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps search monitors on their flat estimate without reading PDF history", async () => {
    const search = {
      ...monitor,
      targets: [
        {
          id: "search-target",
          type: "search",
          queries: ["docs"],
          maxResults: 10,
          depth: "raw",
        },
      ],
    } as MonitorRow;
    expect(
      (await createMonitorCheck({ monitor: search, trigger: "manual" }))
        .estimated_credits,
    ).toBe(2);
    expect(select).not.toHaveBeenCalled();
  });
});
