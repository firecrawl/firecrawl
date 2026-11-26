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

/** Returns true when `value` is a non-null, non-array plain object. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Returns true when `value` is a non-null, non-array object suitable for property lookup. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when `value` is a non-null, non-array object suitable for structured log metadata. */
export function isLogMeta(value: unknown): value is LogMeta {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
