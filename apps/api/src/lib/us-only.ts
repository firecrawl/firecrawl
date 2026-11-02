import type { TeamFlags } from "../controllers/v2/types";

/** Whether the team must be served by US-based vendors only. Any value but `true` reads as unrestricted. */
export function isUsOnly(flags: TeamFlags | undefined): boolean {
  return flags?.usOnly === true;
}
