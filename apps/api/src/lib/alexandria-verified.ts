import type { TeamFlags } from "../controllers/v2/types";

/**
 * Whether the team carries the Alexandria Verified flag. Any value but `true` reads as off, so
 * Exchange providers that only Verified teams may run stay refused.
 */
export function isAlexandriaVerified(
  flags: TeamFlags | null | undefined,
): boolean {
  return flags?.alexandriaVerified === true;
}

/** The header that tells Exchange the team is Alexandria Verified. Built here, never forwarded. */
export function alexandriaVerifiedHeader(
  flags: TeamFlags | null | undefined,
): Record<string, string> {
  return isAlexandriaVerified(flags)
    ? { "x-exchange-alexandria-verified": "true" }
    : {};
}
