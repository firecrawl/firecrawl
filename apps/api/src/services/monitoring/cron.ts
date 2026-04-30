const MIN_MONITOR_INTERVAL_MS = 15 * 60 * 1000;
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

type CronField = Set<number>;

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

function matches(date: Date, cron: ReturnType<typeof parseCron>): boolean {
  return (
    cron.minutes.has(date.getUTCMinutes()) &&
    cron.hours.has(date.getUTCHours()) &&
    cron.daysOfMonth.has(date.getUTCDate()) &&
    cron.months.has(date.getUTCMonth() + 1) &&
    cron.daysOfWeek.has(date.getUTCDay())
  );
}

export function getNextMonitorRunAt(
  cronExpression: string,
  from = new Date(),
): Date {
  const cron = parseCron(cronExpression);
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
    if (matches(candidate, cron)) {
      return new Date(candidate);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("Cron expression did not produce a run within one year");
}

export function validateMonitorCron(cronExpression: string): {
  nextRunAt: Date;
  intervalMs: number;
} {
  const nextRunAt = getNextMonitorRunAt(cronExpression);
  const secondRunAt = getNextMonitorRunAt(cronExpression, nextRunAt);
  const intervalMs = secondRunAt.getTime() - nextRunAt.getTime();
  if (intervalMs < MIN_MONITOR_INTERVAL_MS) {
    throw new Error(
      "Monitor schedule must not run more often than every 15 minutes",
    );
  }

  return { nextRunAt, intervalMs };
}

export function estimateRunsPerMonth(intervalMs: number): number {
  const daysPerMonth = 30;
  return Math.ceil((daysPerMonth * 24 * 60 * 60 * 1000) / intervalMs);
}
