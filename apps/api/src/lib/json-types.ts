import { z } from "zod";

/** Zod schema matching any JSON-serializable value (recursively validated). */
export const jsonValueSchema = z.json();

/** Zod schema matching a plain JSON object (string keys mapped to JSON values). */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** Zod schema matching a JSON object that may carry explicit undefined values in memory. */
export const jsonRecordSchema = z.record(
  z.string(),
  jsonValueSchema.optional(),
);

/** Primitive values representable in JSON. */
type JsonPrimitive = string | number | boolean | null;

/** Any JSON-serializable value. */
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue | undefined>
  | { readonly [key: string]: JsonValue | undefined };

/** A JSON-serializable key-value object. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** Structured log metadata value accepted by application and service loggers. */
type LogMetaValue = JsonValue | Error | Date | undefined;

/** Structured metadata object passed to loggers. */
export type LogMeta = { [key: string]: LogMetaValue };
