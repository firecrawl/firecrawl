import type { MockedFunction } from "vitest";
import { addMonitorCheckJob } from "./queue";
import { enqueueDueMonitorChecks } from "./scheduler";
import { isMonitorCheckStale } from "./stale";
import {
  advanceMonitorAfterSkippedCheck,
  claimDueMonitors,
  createMonitorCheck,
  dispatchScheduledMonitorCheck,
  getMonitorCheck,
  updateMonitorCheck,
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
  getMonitorCheck: vi.fn(),
  updateMonitorCheck: vi.fn(),
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
const mockGetMonitorCheck = getMonitorCheck as MockedFunction<
  typeof getMonitorCheck
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
  } as any;
  const check = { id: "check-1" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimDueMonitors.mockResolvedValue([monitor]);
    mockCreateMonitorCheck.mockResolvedValue(check);
    mockDispatchScheduledMonitorCheck.mockResolvedValue(true);
    mockAddMonitorCheckJob.mockResolvedValue(undefined);
    mockAdvanceMonitorAfterSkippedCheck.mockResolvedValue(undefined);
    mockUpdateMonitorScheduleAfterRun.mockResolvedValue(undefined);
    mockGetMonitorCheck.mockResolvedValue(null);
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
    expect(mockAddMonitorCheckJob).toHaveBeenCalledWith({
      monitorId: monitor.id,
      checkId: check.id,
      teamId: monitor.team_id,
    });
    expect(
      mockDispatchScheduledMonitorCheck.mock.invocationCallOrder[0],
    ).toBeLessThan(mockAddMonitorCheckJob.mock.invocationCallOrder[0]);
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

  it("clears a stale current check before enqueueing a scheduled run", async () => {
    const monitorWithCurrentCheck = {
      ...monitor,
      current_check_id: "stale-check",
    } as any;
    const staleCheck = { id: "stale-check", status: "running" } as any;
    const failedStaleCheck = { ...staleCheck, status: "failed" } as any;
    mockClaimDueMonitors.mockResolvedValue([monitorWithCurrentCheck]);
    mockGetMonitorCheck.mockResolvedValue(staleCheck);
    mockIsMonitorCheckStale.mockReturnValue(true);
    mockUpdateMonitorCheck.mockResolvedValue(failedStaleCheck);

    await expect(
      enqueueDueMonitorChecks({ workerId: "worker-1" }),
    ).resolves.toBe(1);

    expect(mockUpdateMonitorCheck).toHaveBeenCalledWith(staleCheck.id, {
      status: "failed",
      finished_at: expect.any(String),
      actual_credits: 0,
      billing_status: "not_applicable",
      error: "Monitor check exceeded the 1 hour running timeout.",
    });
    expect(mockUpdateMonitorScheduleAfterRun).toHaveBeenCalledWith({
      monitor: monitorWithCurrentCheck,
      check: failedStaleCheck,
    });
    expect(mockCreateMonitorCheck).toHaveBeenCalledWith({
      monitor: { ...monitorWithCurrentCheck, current_check_id: null },
      trigger: "scheduled",
      scheduledFor: monitorWithCurrentCheck.next_run_at,
    });
    expect(mockAddMonitorCheckJob).toHaveBeenCalledWith({
      monitorId: monitorWithCurrentCheck.id,
      checkId: check.id,
      teamId: monitorWithCurrentCheck.team_id,
    });
  });
});
