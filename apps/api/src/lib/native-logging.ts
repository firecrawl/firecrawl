import type { Logger } from "winston";
import { z } from "zod";
import { jsonObjectSchema } from "./json-types";
import { safeParseLogged } from "./zod-log";

const NATIVE_LOGS_SEPARATOR = "\n__native_logs__:";

const nativeLogEntryFieldsSchema = z.object({
  level: z.string(),
  target: z.string(),
  message: z.string(),
  fields: jsonObjectSchema.nullish().transform(value => value ?? {}),
});

// serde_json writes `timestamp_ms`, while NAPI object bindings expose `timestampMs`.
const nativeLogEntrySchema = z.union([
  nativeLogEntryFieldsSchema.extend({ timestamp_ms: z.number() }),
  nativeLogEntryFieldsSchema.extend({ timestampMs: z.number() }),
]);

/** Matches the NativeLogEntry struct from Rust (@mendable/firecrawl-rs). */
type NativeLogEntry = z.infer<typeof nativeLogEntrySchema>;

const nativeLogsArraySchema = z.array(nativeLogEntrySchema);

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
    const validated = safeParseLogged(
      nativeLogsArraySchema,
      parsed,
      "native-logging.logsArray",
    );
    if (!validated.success) {
      return;
    }
    // Only strip after successful validation so we don't lose data on failure
    error.message = error.message.slice(0, idx);
    emitNativeLogs(validated.data, parentLogger, module);
  } catch {
    // JSON parse failed, leave the original error message intact
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
