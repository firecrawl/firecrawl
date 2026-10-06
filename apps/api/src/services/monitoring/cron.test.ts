import { getNextMonitorRunAt, validateMonitorCron } from "./cron";

// Minute-by-minute reference: the previous implementation, kept here so the
// jump-based search is checked against it over short horizons (it costs one
// Intl format per minute, so horizons stay at a few days).
function referenceNextRun(cron: string, from: Date, timeZone: string): Date {
  const [mi, h, dom, mo, dow] = cron.trim().split(/\s+/);
  const expand = (field: string, min: number, max: number) => {
    const out = new Set<number>();
    for (const part of field.split(",")) {
      const [range, stepPart] = part.split("/");
      const step = stepPart ? Number(stepPart) : 1;
      let start = min;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) [start, end] = range.split("-").map(Number);
        else start = end = Number(range);
      }
      for (let v = start; v <= end; v += step) out.add(v);
    }
    return out;
  };
  const minutes = expand(mi, 0, 59);
  const hours = expand(h, 0, 23);
  const days = expand(dom, 1, 31);
  const months = expand(mo, 1, 12);
  const weekdays = expand(dow, 0, 7);
  if (weekdays.has(7)) weekdays.add(0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  const wd: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let i = 0; i < 10 * 24 * 60; i++) {
    const p = Object.fromEntries(
      fmt
        .formatToParts(candidate)
        .filter(x => x.type !== "literal")
        .map(x => [x.type, x.value]),
    );
    if (
      minutes.has(Number(p.minute)) &&
      hours.has(Number(p.hour)) &&
      days.has(Number(p.day)) &&
      months.has(Number(p.month)) &&
      weekdays.has(wd[String(p.weekday).toLowerCase()])
    ) {
      return new Date(candidate);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error("reference: no run within 10 days");
}

describe("getNextMonitorRunAt", () => {
  const cases: Array<[cron: string, from: string, timeZone: string]> = [
    // Plain schedules.
    ["*/5 * * * *", "2027-06-15T10:03:20Z", "UTC"],
    ["0 * * * *", "2027-06-15T10:03:20Z", "UTC"],
    ["30 9 * * *", "2027-06-15T10:03:20Z", "UTC"],
    ["30 9 * * *", "2027-06-15T10:03:20Z", "Asia/Kolkata"],
    ["30 9 * * *", "2027-06-15T10:03:20Z", "Pacific/Chatham"],
    ["0 9 * * 1", "2027-06-15T10:03:20Z", "America/Chicago"],
    ["0 9 1,8,15,22 * *", "2027-06-10T00:00:00Z", "America/New_York"],
    ["15,45 8-17 * * 1-5", "2027-06-18T16:50:00Z", "Europe/Berlin"],
    ["0 6 * * 1,4", "2027-06-15T06:00:00Z", "UTC"],
    ["0 0 * * 0", "2027-06-15T10:03:20Z", "Europe/London"],
    ["59 23 * * *", "2027-06-15T23:58:30Z", "UTC"],
    ["0 0 * * *", "2027-06-15T23:59:30Z", "Australia/Sydney"],
    // US spring forward (2027-03-14 02:00 -> 03:00 local): 02:30 does not exist.
    ["30 2 * * *", "2027-03-13T12:00:00Z", "America/New_York"],
    ["0 * * * *", "2027-03-14T06:30:00Z", "America/New_York"],
    ["15 1 * * *", "2027-03-14T05:00:00Z", "America/New_York"],
    ["0 3 * * *", "2027-03-14T06:30:00Z", "America/New_York"],
    // US fall back (2027-11-07 02:00 -> 01:00 local): 01:30 happens twice.
    ["30 1 * * *", "2027-11-07T04:00:00Z", "America/New_York"],
    ["0 2 * * *", "2027-11-07T04:00:00Z", "America/New_York"],
    ["0 0 * * *", "2027-11-07T04:00:00Z", "America/New_York"],
    // Europe spring forward (2027-03-28 01:00 -> 02:00 local).
    ["30 1 * * *", "2027-03-27T12:00:00Z", "Europe/London"],
    ["0 0 * * *", "2027-03-28T00:30:00Z", "Europe/London"],
    // Southern hemisphere DST end (2027-04-04 03:00 -> 02:00 local).
    ["30 2 * * *", "2027-04-03T12:00:00Z", "Australia/Sydney"],
    // Two-hour spring-forward (Antarctica/Troll, 2027-03-28 01:00 UTC): a
    // 23 h jump in UTC would land at 02:00 local the next day (Monday 03-29).
    ["0 0 * * 1", "2027-03-28T00:00:00Z", "Antarctica/Troll"],
    ["0 0 * * *", "2027-03-27T12:00:00Z", "Antarctica/Troll"],
    ["30 23 * * *", "2027-03-27T22:00:00Z", "Antarctica/Troll"],
    ["0 2 * * *", "2027-03-27T12:00:00Z", "Antarctica/Troll"],
    ["30 1 * * *", "2027-03-27T12:00:00Z", "Antarctica/Troll"],
    // Half-hour DST shift (Australia/Lord_Howe, 2027-04-04 02:00 -> 01:30).
    ["0 2 * * *", "2027-04-03T12:00:00Z", "Australia/Lord_Howe"],
    ["45 1 * * *", "2027-04-03T12:00:00Z", "Australia/Lord_Howe"],
    // Zones that shift at local midnight.
    ["0 0 * * *", "2027-03-27T12:00:00Z", "Asia/Beirut"],
    ["30 0 * * *", "2027-04-03T12:00:00Z", "America/Santiago"],
  ];

  it.each(cases)(
    "matches the minute-by-minute reference for %s from %s in %s",
    (cron, from, timeZone) => {
      const fromDate = new Date(from);
      const actual = getNextMonitorRunAt(cron, fromDate, timeZone);
      expect(actual.toISOString()).toBe(
        referenceNextRun(cron, fromDate, timeZone).toISOString(),
      );
      // Chained: the second run must also agree.
      const second = getNextMonitorRunAt(cron, actual, timeZone);
      expect(second.toISOString()).toBe(
        referenceNextRun(cron, actual, timeZone).toISOString(),
      );
    },
  );

  it("finds a yearly run in milliseconds, not tens of seconds", () => {
    const start = Date.now();
    const next = getNextMonitorRunAt(
      "0 0 1 1 *",
      new Date("2027-02-03T04:05:00Z"),
      "UTC",
    );
    const second = getNextMonitorRunAt("0 0 1 1 *", next, "UTC");
    expect(next.toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(second.toISOString()).toBe("2029-01-01T00:00:00.000Z");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("still rejects a cron with no run inside a year, quickly", () => {
    const start = Date.now();
    expect(() =>
      getNextMonitorRunAt("0 0 30 2 *", new Date("2027-06-15T00:00:00Z")),
    ).toThrow("did not produce a run within one year");
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("validateMonitorCron", () => {
  it("returns a yearly interval for a yearly cron", () => {
    const { intervalMs } = validateMonitorCron("0 0 1 1 *", "UTC");
    expect(intervalMs / (24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(365);
    expect(intervalMs / (24 * 60 * 60 * 1000)).toBeLessThanOrEqual(366);
  });

  it("keeps the five-minute floor", () => {
    expect(validateMonitorCron("*/5 * * * *").intervalMs).toBe(5 * 60 * 1000);
    expect(() => validateMonitorCron("*/4 * * * *")).toThrow(
      "must not run more often than every 5 minutes",
    );
  });
});
