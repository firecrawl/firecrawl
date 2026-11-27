import type { FormatObject } from "../controllers/v2/types";

/**
 * Checks if a format of a specific type exists in the formats array.
 * Returns the format object if found, undefined otherwise.
 *
 * This function handles both simple formats (e.g., { type: "markdown" })
 * and complex formats with additional properties (e.g., { type: "screenshot", fullPage: true }).
 *
 * @param formats - Array of format objects
 * @param type - The format type to search for
 * @returns The format object if found, undefined otherwise
 */
export function hasFormatOfType<
  F extends { type: string } = FormatObject,
  T extends F["type"] = F["type"],
>(
  formats: ReadonlyArray<F> | undefined,
  type: T,
):
  | (F extends { type: infer FT extends string }
      ? T extends FT
        ? F
        : never
      : never)
  | undefined {
  if (!formats) {
    return undefined;
  }

  return formats.find(
    (
      f,
    ): f is F extends { type: infer FT extends string }
      ? T extends FT
        ? F
        : never
      : never => f.type === type,
  );
}

/**
 * Checks if a format of a specific type exists in a formats array.
 * Works with both v1-style string arrays and v2-style object arrays.
 *
 * @param formats - Array of format strings or objects
 * @param type - The format type to check for
 * @returns true if the format exists, false otherwise
 *
 * @example
 * // v2 style (object array)
 * includesFormat([{ type: "markdown" }, { type: "html" }], "markdown") // true
 *
 * // v1 style (string array)
 * includesFormat(["markdown", "html"], "markdown") // true
 */
export function includesFormat(
  formats: Array<string | FormatObject> | undefined,
  type: string,
): boolean {
  if (!formats) {
    return false;
  }

  return formats.some(f =>
    typeof f === "string" ? f === type : f.type === type,
  );
}
