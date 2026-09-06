import {
  unchangedPagesFreeForInterval,
  unchangedPagesFreeForMonitor,
} from "./unchanged-billing";

describe("unchangedPagesFreeForInterval", () => {
  const MINUTE = 60 * 1000;

  it("qualifies schedules at or slower than the threshold", () => {
    expect(unchangedPagesFreeForInterval(60 * MINUTE, 60)).toBe(true);
    expect(unchangedPagesFreeForInterval(24 * 60 * MINUTE, 60)).toBe(true);
    expect(unchangedPagesFreeForInterval(15 * MINUTE, 15)).toBe(true);
    expect(unchangedPagesFreeForInterval(24 * 60 * MINUTE, 1440)).toBe(true);
  });

  it("rejects schedules faster than the threshold", () => {
    expect(unchangedPagesFreeForInterval(30 * MINUTE, 60)).toBe(false);
    expect(unchangedPagesFreeForInterval(5 * MINUTE, 15)).toBe(false);
    expect(unchangedPagesFreeForInterval(60 * MINUTE, 1440)).toBe(false);
  });
});

describe("unchangedPagesFreeForMonitor", () => {
  const daily = { schedule_cron: "0 0 * * *", schedule_timezone: "UTC" };

  it("applies the resolved threshold to the monitor's schedule", () => {
    expect(unchangedPagesFreeForMonitor(daily, 15)).toBe(true);
    expect(
      unchangedPagesFreeForMonitor(
        { schedule_cron: "*/5 * * * *", schedule_timezone: "UTC" },
        15,
      ),
    ).toBe(false);
  });

  it("disqualifies when the threshold could not be resolved", () => {
    expect(unchangedPagesFreeForMonitor(daily, null)).toBe(false);
  });

  it("disqualifies an unparseable schedule", () => {
    expect(
      unchangedPagesFreeForMonitor(
        { schedule_cron: "not a cron", schedule_timezone: "UTC" },
        15,
      ),
    ).toBe(false);
  });
});
