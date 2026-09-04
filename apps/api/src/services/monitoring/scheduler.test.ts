import type { MockedFunction } from "vitest";
import { addMonitorCheckJob } from "./queue";
import { enqueueDueMonitorChecks } from "./scheduler";
import { isMonitorCheckStale } from "./stale";
import {
  advanceMonitorAfterSkippedCheck,
  claimDueMonitors,
  createMonitorCheck,
  dispatchScheduledMonitorCheck,
  getMonitorCheckForUpdate,
  updateMonitorCheck,
  updateMonitorCheckIfStatus,
  updateMonitorScheduleAfterRun,
} from "./store";
import { autumnService } from "../autumn/autumn.service";

vi.mock("./queue", () => ({
  addMonitorCheckJob: vi.fn(),
}));

vi.mock("./store", () => ({
  advanceMonitorAfterSkippedCheck: vi.fn(),
  claimDueMonitors: vi.fn(),
  createMonitorCheck: vi.fn(),
  dispatchScheduledMonitorCheck: vi.fn(),
  getMonitorCheckForUpdate: vi.fn(),
  updateMonitorCheck: vi.fn(),
  updateMonitorCheckIfStatus: vi.fn(),
  updateMonitorScheduleAfterRun: vi.fn(),
}));

vi.mock("./stale", () => ({
  isMonitorCheckStale: vi.fn(),
  MONITOR_CHECK_STALE_ERROR:
    "Monitor check exceeded the 1 hour running timeout.",
}));

vi.mock("../autumn/autumn.service", () => ({
  autumnService: {
    finalizeCreditsLock: vi.fn(),
  },
}));

const mockAddMonitorCheckJob = addMonitorCheckJob as MockedFunction<
  typeof addMonitorCheckJob
>;
const mockClaimDueMonitors = claimDueMonitors as MockedFunction<
  typeof claimDueMonitors
>;
const mockCreateMonitorCheck = createMonitorCheck as MockedFunction<
  typeof createMonitorCheck
>;
const mockDispatchScheduledMonitorCheck =
  dispatchScheduledMonitorCheck as MockedFunction<
    typeof dispatchScheduledMonitorCheck
  >;
const mockGetMonitorCheckForUpdate = getMonitorCheckForUpdate as MockedFunction<
  typeof getMonitorCheckForUpdate
>;
const mockIsMonitorCheckStale = isMonitorCheckStale as MockedFunction<
  typeof isMonitorCheckStale
>;
const mockFinalizeCreditsLock =
  autumnService.finalizeCreditsLock as MockedFunction<
    typeof autumnService.finalizeCreditsLock
  >;
const mockUpdateMonitorCheck = updateMonitorCheck as MockedFunction<
  typeof updateMonitorCheck
>;
const mockAdvanceMonitorAfterSkippedCheck =
  advanceMonitorAfterSkippedCheck as MockedFunction<
    typeof advanceMonitorAfterSkippedCheck
  >;
const mockUpdateMonitorScheduleAfterRun =
  updateMonitorScheduleAfterRun as MockedFunction<
    typeof updateMonitorScheduleAfterRun
  >;

describe("monitoring scheduler", () => {
  const monitor = {
    id: "monitor-1",
    team_id: "team-1",
    current_check_id: null,
    next_run_at: "2026-05-05T18:45:00.000Z",
    schedule_cron: "0 9 * * *",
    schedule_timezone: "UTC",
    targets: [{ id: "t-1", type: "scrape" }],
  } as any;
  const check = { id: "check-1" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimDueMonitors.mockResolvedValue([monitor]);
    mockCreateMonitorCheck.mockResolvedValue(check);
    mockDispatchScheduledMonitorCheck.mockResolvedValue(true);
    mockAddMonitorCheckJob.mockResolvedValue(undefined);
    mockUpdateMonitorCheck.mockImplementation(
      async (id, patch) =>
        ({
          id,
          ...patch,
        }) as any,
    );
    mockAdvanceMonitorAfterSkippedCheck.mockResolvedValue(undefined);
    mockUpdateMonitorScheduleAfterRun.mockResolvedValue(undefined);
    mockGetMonitorCheckForUpdate.mockResolvedValue(null);
    mockIsMonitorCheckStale.mockReturnValue(false);
    mockFinalizeCreditsLock.mockResolvedValue(undefined as any);
  });

  it("dispatches and advances a scheduled monitor before enqueueing its job", async () => {
    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(1);

    expect(mockCreateMonitorCheck).toHaveBeenCalledWith({
      monitor,
      trigger: "scheduled",
      scheduledFor: monitor.next_run_at,
    });
    expect(mockDispatchScheduledMonitorCheck).toHaveBeenCalledWith({
      monitor,
      checkId: check.id,
    });
    expect(mockAddMonitorCheckJob).toHaveBeenCalledWith(
      {
        monitorId: monitor.id,
        checkId: check.id,
        teamId: monitor.team_id,
      },
      { search: false },
    );
    expect(
      mockDispatchScheduledMonitorCheck.mock.invocationCallOrder[0],
    ).toBeLessThan(mockAddMonitorCheckJob.mock.invocationCallOrder[0]);
  });

  it("routes a search monitor to the dedicated search queue", async () => {
    mockClaimDueMonitors.mockResolvedValue([
      { ...monitor, targets: [{ id: "t-1", type: "search" }] } as any,
    ]);

    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(1);

    expect(mockAddMonitorCheckJob).toHaveBeenCalledWith(
      {
        monitorId: monitor.id,
        checkId: check.id,
        teamId: monitor.team_id,
      },
      { search: true },
    );
  });

  it("fails and clears a dispatched check when enqueueing fails", async () => {
    const error = new Error("queue unavailable");
    const failed = { id: check.id, status: "failed" } as any;
    mockAddMonitorCheckJob.mockRejectedValue(error);
    mockUpdateMonitorCheck.mockResolvedValue(failed);

    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(0);

    expect(mockUpdateMonitorCheck).toHaveBeenCalledWith(check.id, {
      status: "failed",
      finished_at: expect.any(String),
      error: error.message,
    });
    expect(mockUpdateMonitorScheduleAfterRun).toHaveBeenCalledWith({
      monitor,
      check: failed,
    });
  });

  it("records an overlap if dispatch finds another running check", async () => {
    const skipped = { id: check.id, status: "skipped_overlap" } as any;
    mockDispatchScheduledMonitorCheck.mockResolvedValue(false);
    mockUpdateMonitorCheck.mockResolvedValue(skipped);

    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(0);

    expect(mockAddMonitorCheckJob).not.toHaveBeenCalled();
    expect(mockUpdateMonitorCheck).toHaveBeenCalledWith(check.id, {
      status: "skipped_overlap",
      finished_at: expect.any(String),
      error: "Previous monitor check is still running.",
    });
    expect(mockAdvanceMonitorAfterSkippedCheck).toHaveBeenCalledWith({
      monitor,
      check: skipped,
    });
  });

  it("records an overlap while the current check is still active", async () => {
    const active = { id: "active-check", status: "running" } as any;
    const monitorWithCurrentCheck = {
      ...monitor,
      current_check_id: active.id,
    };
    const skipped = { id: check.id, status: "skipped_overlap" } as any;
    mockClaimDueMonitors.mockResolvedValue([monitorWithCurrentCheck]);
    mockGetMonitorCheckForUpdate.mockResolvedValue(active);
    mockUpdateMonitorCheck.mockResolvedValue(skipped);

    await expect(enqueueDueMonitorChecks()).resolves.toBe(0);

    expect(mockCreateMonitorCheck).toHaveBeenCalledExactlyOnceWith({
      monitor: monitorWithCurrentCheck,
      trigger: "scheduled",
      scheduledFor: monitor.next_run_at,
      status: "skipped_overlap",
    });
    expect(mockAdvanceMonitorAfterSkippedCheck).toHaveBeenCalledExactlyOnceWith(
      {
        monitor: monitorWithCurrentCheck,
        check: skipped,
      },
    );
    expect(updateMonitorCheckIfStatus).not.toHaveBeenCalled();
    expect(mockDispatchScheduledMonitorCheck).not.toHaveBeenCalled();
    expect(mockAddMonitorCheckJob).not.toHaveBeenCalled();
  });

  it("clears a stale current check before enqueueing a scheduled run", async () => {
    const monitorWithCurrentCheck = {
      ...monitor,
      current_check_id: "stale-check",
    } as any;
    const staleCheck = { id: "stale-check", status: "running" } as any;
    const failedStaleCheck = { ...staleCheck, status: "failed" } as any;
    const finalizedStaleCheck = {
      ...failedStaleCheck,
      billing_status: "not_applicable",
    };
    mockClaimDueMonitors.mockResolvedValue([monitorWithCurrentCheck]);
    mockGetMonitorCheckForUpdate.mockResolvedValue(staleCheck);
    mockIsMonitorCheckStale.mockReturnValue(true);
    vi.mocked(updateMonitorCheckIfStatus).mockResolvedValue(failedStaleCheck);
    mockUpdateMonitorCheck.mockResolvedValue(finalizedStaleCheck);

    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(1);

    expect(updateMonitorCheckIfStatus).toHaveBeenCalledWith(
      staleCheck.id,
      "running",
      {
        status: "failed",
        finished_at: expect.any(String),
        actual_credits: 0,
        error: "Monitor check exceeded the 1 hour running timeout.",
      },
    );
    expect(mockUpdateMonitorScheduleAfterRun).toHaveBeenCalledWith({
      monitor: monitorWithCurrentCheck,
      check: finalizedStaleCheck,
    });
    expect(mockCreateMonitorCheck).toHaveBeenCalledWith({
      monitor: { ...monitorWithCurrentCheck, current_check_id: null },
      trigger: "scheduled",
      scheduledFor: monitorWithCurrentCheck.next_run_at,
    });
    expect(mockAddMonitorCheckJob).toHaveBeenCalledWith(
      {
        monitorId: monitorWithCurrentCheck.id,
        checkId: check.id,
        teamId: monitorWithCurrentCheck.team_id,
      },
      { search: false },
    );
  });
  it.each(["running", "queued"] as const)(
    "releases a stale %s hold only after claiming failure",
    async status => {
      const stale = {
        id: "stale-check",
        status,
        autumn_lock_id: "monitor_stale-check",
      } as any;
      mockClaimDueMonitors.mockResolvedValue([
        { ...monitor, current_check_id: stale.id },
      ]);
      mockGetMonitorCheckForUpdate.mockResolvedValue(stale);
      mockIsMonitorCheckStale.mockReturnValue(true);
      vi.mocked(updateMonitorCheckIfStatus).mockResolvedValue({
        ...stale,
        status: "failed",
      });

      await enqueueDueMonitorChecks();

      expect(updateMonitorCheckIfStatus).toHaveBeenCalledWith(
        stale.id,
        status,
        expect.objectContaining({ status: "failed" }),
      );
      expect(mockFinalizeCreditsLock).toHaveBeenCalledWith(
        expect.objectContaining({
          lockId: stale.autumn_lock_id,
          action: "release",
        }),
      );
      expect(
        vi.mocked(updateMonitorCheckIfStatus).mock.invocationCallOrder[0],
      ).toBeLessThan(mockFinalizeCreditsLock.mock.invocationCallOrder[0]);
    },
  );

  it("does not release or rewrite a check when another finalizer wins the terminal claim", async () => {
    const stale = {
      id: "stale-check",
      status: "running",
      autumn_lock_id: "monitor_stale-check",
    } as any;
    mockClaimDueMonitors.mockResolvedValue([
      { ...monitor, current_check_id: stale.id },
    ]);
    mockGetMonitorCheckForUpdate.mockResolvedValue(stale);
    mockIsMonitorCheckStale.mockReturnValue(true);
    vi.mocked(updateMonitorCheckIfStatus).mockResolvedValue(null);

    await enqueueDueMonitorChecks();

    expect(mockFinalizeCreditsLock).not.toHaveBeenCalled();
    expect(mockUpdateMonitorScheduleAfterRun).not.toHaveBeenCalled();
    expect(mockCreateMonitorCheck).not.toHaveBeenCalled();
    expect(mockUpdateMonitorCheck).not.toHaveBeenCalled();
    expect(mockAdvanceMonitorAfterSkippedCheck).not.toHaveBeenCalled();
    expect(mockDispatchScheduledMonitorCheck).not.toHaveBeenCalled();
    expect(mockAddMonitorCheckJob).not.toHaveBeenCalled();
  });

  it.each([
    { previousLock: null, claimedLock: "current-lock" },
    { previousLock: "previous-lock", claimedLock: null },
    { previousLock: "previous-lock", claimedLock: "current-lock" },
  ])(
    "settles the claimed hold when it changes from $previousLock to $claimedLock",
    async ({ previousLock, claimedLock }) => {
      const current = {
        id: "stale-check",
        status: "running",
        autumn_lock_id: previousLock,
      } as any;
      const claimed = {
        ...current,
        status: "failed",
        autumn_lock_id: claimedLock,
      };
      mockClaimDueMonitors.mockResolvedValue([
        { ...monitor, current_check_id: current.id },
      ]);
      mockGetMonitorCheckForUpdate.mockResolvedValue(current);
      mockIsMonitorCheckStale.mockReturnValue(true);
      vi.mocked(updateMonitorCheckIfStatus).mockResolvedValue(claimed);
      mockUpdateMonitorCheck.mockImplementation(async (_id, patch) => ({
        ...claimed,
        ...patch,
      }));

      await enqueueDueMonitorChecks();

      expect(
        vi.mocked(updateMonitorCheckIfStatus).mock.calls[0][2],
      ).not.toHaveProperty("billing_status");
      if (claimedLock) {
        expect(mockFinalizeCreditsLock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lockId: claimedLock, action: "release" }),
        );
      } else {
        expect(mockFinalizeCreditsLock).not.toHaveBeenCalled();
      }
      expect(mockUpdateMonitorCheck).toHaveBeenCalledWith(current.id, {
        billing_status: claimedLock ? "released" : "not_applicable",
      });
      expect(mockUpdateMonitorScheduleAfterRun).toHaveBeenCalledWith({
        monitor: expect.objectContaining({ id: monitor.id }),
        check: expect.objectContaining({
          autumn_lock_id: claimedLock,
          billing_status: claimedLock ? "released" : "not_applicable",
        }),
      });
    },
  );
});
