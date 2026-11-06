import type { TeamFlags } from "../controllers/v2/types";

/** Whether the team must be served by US-based vendors only. Any value but `true` reads as unrestricted. */
export function isUsOnly(flags: TeamFlags | undefined): boolean {
  return flags?.usOnly === true;
}

const US_COUNTRIES = ["us", "us-generic"];

/**
 * The refusal for a US-only team asking for a country other than the US, since
 * its pages are fetched only from US exits. Undefined for an unrestricted team
 * or when every country given is "us" or "us-generic" (the schema default).
 */
export function usOnlyLocationRefusal(
  flags: TeamFlags | undefined,
  ...countries: unknown[]
): string | undefined {
  if (!isUsOnly(flags)) return undefined;
  const country = countries.find(
    (value): value is string =>
      typeof value === "string" &&
      value !== "" &&
      !US_COUNTRIES.includes(value.toLowerCase()),
  );
  return country === undefined
    ? undefined
    : `location.country "${country.toUpperCase()}" isn't available to teams restricted to US-only processing, because pages are fetched only from US exits. Omit location or set it to "US".`;
}

/** The `data_region` value that pins a US-only team's GPU work to US capacity. */
export const US_DATA_REGION = "us";

/**
 * Whether a GPU service reply refuses a pinned request because no in-region
 * capacity could take it. Accepts a parsed body or raw JSON text.
 */
export function isRegionUnavailable(body: unknown): boolean {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const fields = parsed as Record<string, unknown>;
  return ["code", "error_code", "error_class", "error"].some(
    key => fields[key] === "region_unavailable",
  );
}
