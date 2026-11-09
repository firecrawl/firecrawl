const MIN_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

type CronField = Set<number>;
type CronSpec = ReturnType<typeof parseCron>;

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseMinuteStart(value: string | undefined): number {
  if (value === undefined) return 0;
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Schedule start minute must be between 0 and 59");
  }
  return minute;
}

function assertDivides(value: number, divisor: number, unit: string) {
  if (divisor % value !== 0) {
    throw new Error(`${unit} interval must divide evenly into ${divisor}`);
  }
}

export function parseMonitorScheduleText(input: string): string {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ");

  const minuteMatch = text.match(
    /^every (\d+) (?:minutes?|mins?)(?: (?:starting|start)(?: at| on)? :?(\d{1,2}))?$/,
  );
  if (minuteMatch) {
    const interval = Number(minuteMatch[1]);
    if (!Number.isInteger(interval) || interval <= 0 || interval > 60) {
      throw new Error("Minute interval must be between 1 and 60");
    }
    assertDivides(interval, 60, "Minute");
    const startMinute = parseMinuteStart(minuteMatch[2]);
    return startMinute === 0
      ? `*/${interval} * * * *`
      : `${startMinute}-59/${interval} * * * *`;
  }

  const hourlyMatch = text.match(
    /^(?:hourly|every hour)(?: (?:at|starting at) :?(\d{1,2}))?$/,
  );
  if (hourlyMatch) {
    return `${parseMinuteStart(hourlyMatch[1])} * * * *`;
  }

  const hourMatch = text.match(/^every (\d+) (?:hours?|hrs?)$/);
  if (hourMatch) {
    const interval = Number(hourMatch[1]);
    if (!Number.isInteger(interval) || interval <= 0 || interval > 24) {
      throw new Error("Hour interval must be between 1 and 24");
    }
    assertDivides(interval, 24, "Hour");
    return `0 */${interval} * * *`;
  }

  const dailyMatch = text.match(
    /^(?:daily|every day)(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/,
  );
  if (dailyMatch) {
    let hour = dailyMatch[1] === undefined ? 0 : Number(dailyMatch[1]);
    const minute = dailyMatch[2] === undefined ? 0 : Number(dailyMatch[2]);
    const meridiem = dailyMatch[3];
    if (meridiem !== undefined) {
      if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
        throw new Error(
          "Daily schedule hour with am/pm must be between 1 and 12",
        );
      }
      if (meridiem === "am") {
        hour = hour === 12 ? 0 : hour;
      } else {
        hour = hour === 12 ? 12 : hour + 12;
      }
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error("Daily schedule hour must be between 0 and 23");
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error("Daily schedule minute must be between 0 and 59");
    }
    return `${minute} ${hour} * * *`;
  }

  if (text === "weekly" || text === "every week") {
    return "0 0 * * 0";
  }

  throw new Error(
    "Unsupported schedule text. Try phrases like 'every 30 minutes', 'hourly', or 'daily at 9:00'",
  );
}

function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error("Invalid cron step");
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      start = a;
      end = b;
    } else {
      start = Number(rangePart);
      end = start;
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error("Invalid cron field");
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function parseDayOfWeek(field: string): CronField {
  const values = parseField(field, 0, 7);
  if (values.has(7)) {
    values.add(0);
    values.delete(7);
  }
  return values;
}

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron expression must contain five fields");
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseDayOfWeek(parts[4]),
  };
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid monitor schedule timezone: ${timeZone}`);
  }
}

// One formatter per zone: constructing Intl.DateTimeFormat is the expensive
// part, and the next-run search below calls this hundreds of times.
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = zonedFormatter(timeZone).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  );

  return {
    minutes: Number(values.minute),
    hours: Number(values.hour),
    daysOfMonth: Number(values.day),
    months: Number(values.month),
    daysOfWeek: WEEKDAY_TO_NUMBER[String(values.weekday).toLowerCase()],
  };
}

type ZonedParts = ReturnType<typeof getZonedParts>;

function dayMatches(zoned: ZonedParts, cron: CronSpec): boolean {
  return (
    cron.daysOfMonth.has(zoned.daysOfMonth) &&
    cron.months.has(zoned.months) &&
    cron.daysOfWeek.has(zoned.daysOfWeek)
  );
}

function matches(zoned: ZonedParts, cron: CronSpec): boolean {
  return (
    cron.minutes.has(zoned.minutes) &&
    cron.hours.has(zoned.hours) &&
    dayMatches(zoned, cron)
  );
}

/**
 * Local wall-clock position relative to the start of `base`'s local day:
 * negative on the previous day, 0-1439 on the same day, 1440+ on the next.
 * A jump never spans more than one day, so day/month alone identify it.
 */
function localMinutesFrom(base: ZonedParts, zoned: ZonedParts): number {
  const sameDay =
    zoned.daysOfMonth === base.daysOfMonth && zoned.months === base.months;
  const nextDay =
    !sameDay &&
    ((zoned.months === base.months &&
      zoned.daysOfMonth === base.daysOfMonth + 1) ||
      (zoned.months !== base.months && zoned.daysOfMonth === 1));
  const dayOffset = sameDay ? 0 : nextDay ? 24 * 60 : -(24 * 60);
  return dayOffset + zoned.hours * 60 + zoned.minutes;
}

/**
 * The next local wall-clock position (minutes from the start of `zoned`'s
 * local day) that could match: the next day's 00:00 when the day does not
 * match, the next hour when the hour does not, otherwise the next listed
 * minute (or the next hour when none is left in this one).
 */
function nextLocalTarget(zoned: ZonedParts, cron: CronSpec): number {
  const localMinutes = zoned.hours * 60 + zoned.minutes;
  if (!dayMatches(zoned, cron)) return 24 * 60;
  if (!cron.hours.has(zoned.hours)) return (zoned.hours + 1) * 60;
  let nextMinute = Infinity;
  for (const minute of cron.minutes) {
    if (minute > zoned.minutes && minute < nextMinute) nextMinute = minute;
  }
  return nextMinute === Infinity
    ? (zoned.hours + 1) * 60
    : zoned.hours * 60 + nextMinute;
}

/**
 * First instant strictly after `from` (at minute precision) matching the cron
 * in `timeZone`, or an error when none falls within the next year.
 *
 * The search jumps to the next local day, hour or listed minute instead of
 * stepping every minute: a yearly cron used to cost ~500k `Intl` formats
 * (tens of seconds on the event loop, enough to fail the liveness probe); it
 * now costs a few hundred. Jumps are made in UTC minutes, so a UTC offset
 * change inside a jump can land past the intended local target (a two-hour
 * spring-forward, say); the landing point is read back and pulled to the
 * target when that happens. A target that does not exist locally (a gap at
 * midnight) keeps the first instant after it. Landing short (fall-back) just
 * leaves the loop to jump again.
 */
export function getNextMonitorRunAt(
  cronExpression: string,
  from = new Date(),
  timeZone = "UTC",
): Date {
  validateTimeZone(timeZone);
  const cron = parseCron(cronExpression);
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  let advanced = 0;
  while (advanced < SEARCH_LIMIT_MINUTES) {
    const zoned = getZonedParts(candidate, timeZone);
    if (matches(zoned, cron)) {
      return new Date(candidate);
    }

    const target = nextLocalTarget(zoned, cron);
    const step = Math.max(1, target - (zoned.hours * 60 + zoned.minutes));
    let next = new Date(candidate.getTime() + step * 60_000);
    const landed = localMinutesFrom(zoned, getZonedParts(next, timeZone));
    if (landed > target) {
      const pulled = new Date(next.getTime() - (landed - target) * 60_000);
      // Only pull back to an instant that is still after the candidate and
      // still at or past the target: a gap (the target does not exist
      // locally) can otherwise send the search backwards.
      if (
        pulled.getTime() > candidate.getTime() &&
        localMinutesFrom(zoned, getZonedParts(pulled, timeZone)) >= target
      ) {
        next = pulled;
      }
    }

    advanced += (next.getTime() - candidate.getTime()) / 60_000;
    candidate.setTime(next.getTime());
  }

  throw new Error("Cron expression did not produce a run within one year");
}

export function validateMonitorCron(
  cronExpression: string,
  timeZone = "UTC",
): {
  nextRunAt: Date;
  intervalMs: number;
} {
  const nextRunAt = getNextMonitorRunAt(cronExpression, new Date(), timeZone);
  const secondRunAt = getNextMonitorRunAt(cronExpression, nextRunAt, timeZone);
  const intervalMs = secondRunAt.getTime() - nextRunAt.getTime();
  if (intervalMs < MIN_MONITOR_INTERVAL_MS) {
    throw new Error(
      "Monitor schedule must not run more often than every 5 minutes",
    );
  }

  return { nextRunAt, intervalMs };
}

export function estimateRunsPerMonth(intervalMs: number): number {
  const daysPerMonth = 30;
  return Math.ceil((daysPerMonth * 24 * 60 * 60 * 1000) / intervalMs);
}
