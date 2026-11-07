import { config } from "../config";

function parseGcsSignedUrlDate(value: string | null): number {
  if (!value) {
    return NaN;
  }

  const compactDate = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (compactDate) {
    const [, year, month, day, hour, minute, second] = compactDate;
    return Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10),
    );
  }

  return new Date(value).getTime();
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseGcsSignedUrlDate(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function getGcsSignedUrlExpiration(url: URL): number {
  let expiresAt = parseInt(url.searchParams.get("Expires") ?? "0", 10) * 1000;
  if (expiresAt === 0) {
    expiresAt =
      parseGcsSignedUrlDate(url.searchParams.get("X-Goog-Date")) +
      parseInt(url.searchParams.get("X-Goog-Expires") ?? "0", 10) * 1000;
  }

  return expiresAt;
}

export function getGcsScreenshotUrlResignReason(
  url: URL,
  opts: {
    indexCreatedAt?: string | null;
    now?: number;
    resignBefore?: string | null;
  } = {},
): "expired" | "resign_before" | null {
  if (url.hostname !== "storage.googleapis.com") {
    return null;
  }

  if (getGcsSignedUrlExpiration(url) < (opts.now ?? Date.now())) {
    return "expired";
  }

  const resignBeforeMs = parseTimestamp(
    opts.resignBefore ?? config.GCS_SCREENSHOT_RESIGN_BEFORE,
  );
  const indexCreatedAtMs = parseTimestamp(opts.indexCreatedAt);
  if (
    resignBeforeMs !== null &&
    indexCreatedAtMs !== null &&
    indexCreatedAtMs < resignBeforeMs
  ) {
    return "resign_before";
  }

  return null;
}
