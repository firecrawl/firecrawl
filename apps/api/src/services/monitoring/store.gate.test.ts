const { rows, limits, updates, chain } = vi.hoisted(() => {
  const rows: { status: string }[] = [];
  const limits: number[] = [];
  const updates: Record<string, unknown>[] = [];

  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => {
      limits.push(n);
      return Promise.resolve(rows.slice(0, n));
    },
  };

  return { rows, limits, updates, chain };
});

vi.mock("../../db/connection", () => ({
  dbRr: { select: () => chain },
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock("../../db/rpc", () => ({ monitoringClaimDueMonitors: vi.fn() }));

import { countRecentConsecutiveSkippedForCredits, pauseMonitor } from "./store";

function seed(...statuses: string[]) {
  rows.length = 0;
  limits.length = 0;
  rows.push(...statuses.map(status => ({ status })));
}

async function streak(limit = 3) {
  return countRecentConsecutiveSkippedForCredits({
    teamId: "11111111-1111-1111-1111-111111111111",
    monitorId: "22222222-2222-2222-2222-222222222222",
    limit,
  });
}

describe("counting a monitor's credit-skip streak", () => {
  const skipped = "skipped_no_credits";

  it("counts the run ending at the newest check", async () => {
    seed(skipped, skipped, skipped);
    expect(await streak()).toBe(3);
  });

  // The streak is what makes a revoked job wait rather than pause on one bad
  // response, so a single good run in between has to reset it — otherwise a
  // partner that recovered would still lose the monitor on its next blip.
  it("stops at the first check that ran", async () => {
    seed(skipped, "completed", skipped);
    expect(await streak()).toBe(1);
  });

  it("is zero when the newest check is not a skip", async () => {
    seed("completed", skipped, skipped);
    expect(await streak()).toBe(0);
    seed();
    expect(await streak()).toBe(0);
  });

  // Nothing above needs a number bigger than the threshold it compares
  // against, so the query never reads more rows than that.
  it("reads no more rows than the caller's limit", async () => {
    seed(skipped, skipped, skipped, skipped, skipped);
    expect(await streak(3)).toBe(3);
    expect(limits).toEqual([3]);
  });
});

describe("pausing a monitor", () => {
  // paused, not deleted: nothing a partner says on their side should destroy a
  // customer's configuration, and clearing next_run_at is what actually stops
  // the runs from being claimed.
  it("stops the schedule without destroying the monitor", async () => {
    updates.length = 0;
    await pauseMonitor("22222222-2222-2222-2222-222222222222");

    expect(updates[0]).toMatchObject({ status: "paused", next_run_at: null });
  });
});
