import type { Logger } from "winston";
import { isJsonObject } from "./json-types";
import type { JsonObject } from "./json-types";

const NATIVE_LOGS_SEPARATOR = "\n__native_logs__:";

/** Matches the NativeLogEntry struct from Rust (@mendable/firecrawl-rs). */
interface NativeLogEntry {
  level: string;
  target: string;
  message: string;
  fields: JsonObject;
  timestampMs: number;
}

function isNativeLogEntry(value: unknown): value is NativeLogEntry {
  return (
    isJsonObject(value) &&
    typeof value.level === "string" &&
    typeof value.target === "string" &&
    typeof value.message === "string" &&
    isJsonObject(value.fields) &&
    typeof value.timestampMs === "number"
  );
}

/**
 * Extract native logs embedded in a NAPI error message by `embed_logs_in_error`.
 * Emits them through the logger and returns the cleaned error message.
 */
export function extractAndEmitNativeLogs(
  error: unknown,
  parentLogger: Logger,
  module: string,
): void {
  if (!(error instanceof Error)) {
    return;
  }
  const idx = error.message.indexOf(NATIVE_LOGS_SEPARATOR);
  if (idx === -1) {
    return;
  }

  const logsJson = error.message.slice(idx + NATIVE_LOGS_SEPARATOR.length);

  try {
    const parsed: unknown = JSON.parse(logsJson);
    if (!Array.isArray(parsed)) {
      return;
    }
    const logs = parsed.filter(isNativeLogEntry);
    // Only strip after successful parse so we don't lose data on failure
    error.message = error.message.slice(0, idx);
    emitNativeLogs(logs, parentLogger, module);
  } catch {
    // JSON parse failed — leave the original error message intact
  }
}

/**
 * Emit log entries captured inside the Rust native module through a Winston
 * logger, preserving trace context (scrape_id / url via the parent logger)
 * and adding `source: "native"` + the Rust module name as labels.
 */
export function emitNativeLogs(
  logs: Array<NativeLogEntry> | undefined,
  parentLogger: Logger,
  module: string,
): void {
  if (!logs || logs.length === 0) {
    return;
  }

  const childLogger = parentLogger.child({ source: "native", module });

  for (const entry of logs) {
    const meta = {
      rustTarget: entry.target,
      ...entry.fields,
    };

    switch (entry.level) {
      case "error":
        childLogger.error(entry.message, meta);
        break;
      case "warn":
        childLogger.warn(entry.message, meta);
        break;
      case "info":
        childLogger.info(entry.message, meta);
        break;
      case "debug":
      case "trace":
        childLogger.debug(entry.message, meta);
        break;
      default:
        childLogger.info(entry.message, meta);
    }
  }
}
