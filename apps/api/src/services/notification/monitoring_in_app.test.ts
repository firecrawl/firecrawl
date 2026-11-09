import type { Mock } from "vitest";
import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";
import { createInAppNotification } from "./in_app";
import {
  describeMonitorActivity,
  recordMonitorInAppNotification,
} from "./monitoring_in_app";

vi.mock("./in_app", () => ({
  createInAppNotification: vi.fn(async () => true),
}));

vi.mock("./monitoring_slack", () => ({
  shouldSuppressForNoise: vi.fn(
    (monitor: MonitorRow, _check: MonitorCheckRow, pages: any[]) =>
      monitor.judge_enabled &&
      pages.every(page => page.judgment?.meaningful === false),
  ),
}));

const counts = (changed: number, added: number, removed: number) => ({
  changed_count: changed,
  new_count: added,
  removed_count: removed,
});

const monitor = {
  id: "mon-1",
  team_id: "team-1",
  name: "Competitor pricing",
  judge_enabled: false,
} as MonitorRow;

const check = { id: "check-1", ...counts(3, 1, 0) } as MonitorCheckRow;

beforeEach(() => vi.clearAllMocks());

describe("describing a monitor check", () => {
  test("lists only the kinds of activity that happened", () => {
    expect(describeMonitorActivity(counts(3, 1, 0))).toBe(
      "3 pages changed, 1 new page.",
    );
    expect(describeMonitorActivity(counts(1, 0, 2))).toBe(
      "1 page changed, 2 pages removed.",
    );
    expect(describeMonitorActivity(counts(0, 1200, 0))).toBe(
      "1,200 new pages.",
    );
  });

  test("returns nothing when no page changed", () => {
    expect(describeMonitorActivity(counts(0, 0, 0))).toBeNull();
  });
});

describe("recording a monitor notification", () => {
  test("writes the monitor's name, link target and summary", async () => {
    const result = await recordMonitorInAppNotification({
      monitor,
      check,
      pages: [{ url: "https://a.com", status: "changed" }],
    });

    expect(result).toEqual({ attempted: true, success: true });
    expect(createInAppNotification).toHaveBeenCalledWith(
      "team-1",
      "monitorChangeDetected",
      {
        monitorId: "mon-1",
        monitorName: "Competitor pricing",
        checkId: "check-1",
        summary: "3 pages changed, 1 new page.",
      },
    );
  });

  test("reports a failed write without throwing", async () => {
    (createInAppNotification as Mock).mockResolvedValueOnce(false);

    const result = await recordMonitorInAppNotification({
      monitor,
      check,
      pages: [{ url: "https://a.com", status: "changed" }],
    });

    expect(result).toEqual({ attempted: true, success: false });
  });

  test("skips checks with no changes and changes the judge marked as noise", async () => {
    await recordMonitorInAppNotification({
      monitor,
      check: { ...check, ...counts(0, 0, 0) },
      pages: [],
    });
    const suppressed = await recordMonitorInAppNotification({
      monitor: { ...monitor, judge_enabled: true },
      check,
      pages: [
        {
          url: "https://a.com",
          status: "changed",
          judgment: { meaningful: false, confidence: "high", reason: "ad" },
        },
      ],
    });

    expect(suppressed).toMatchObject({ attempted: false, suppressed: true });
    expect(createInAppNotification as Mock).not.toHaveBeenCalled();
  });
});
