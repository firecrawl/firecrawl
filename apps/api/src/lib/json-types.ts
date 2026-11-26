import { z } from "zod";

/** Zod schema matching any JSON-serializable value (recursively validated). */
export const jsonValueSchema = z.json();

/** Exact JSON value type inferred from `z.json()` (mutable arrays/records, no undefined). */
export type StrictJsonValue = z.infer<typeof jsonValueSchema>;

const parsedJsonValueSchema = z.custom<StrictJsonValue>(() => true);

/**
 * Parses a JSON string directly into a `StrictJsonValue` without an extra
 * recursive validation walk, rejecting non-finite numbers such as `1e400`.
 */
export function parseJsonString(text: string): StrictJsonValue {
  return parsedJsonValueSchema.parse(
    JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new SyntaxError("JSON numbers must be finite");
      }
      return value;
    }),
  );
}

/** Zod schema matching a plain JSON object (string keys mapped to JSON values). */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** Primitive values representable in JSON. */
type JsonPrimitive = string | number | boolean | null;

type MutableJsonValue =
  | JsonPrimitive
  | Array<MutableJsonValue | undefined>
  | { [key: string]: MutableJsonValue | undefined };

type MutableJsonObject = { [key: string]: MutableJsonValue | undefined };

/** Zod schema matching a JSON value that may carry explicit undefined entries in memory. */
export const inMemoryJsonValueSchema: z.ZodType<MutableJsonValue | undefined> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.undefined(),
      z.array(inMemoryJsonValueSchema),
      z.record(z.string(), inMemoryJsonValueSchema),
    ]),
  );

/** Zod schema matching a plain JSON object that may carry explicit undefined values in memory. */
export const jsonRecordSchema: z.ZodType<MutableJsonObject> = z.record(
  z.string(),
  inMemoryJsonValueSchema,
);

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
