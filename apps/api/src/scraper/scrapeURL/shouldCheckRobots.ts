import type { TeamFlags } from "../../controllers/v1/types";
import type { ResolvedSafeMode } from "../../lib/safe-mode";

// The invariant "lockdown never fetches robots.txt" is load-bearing for the
// lockdown guarantee (robots.txt is a request to the target domain). Keep this
// in its own file so it can be unit-tested without dragging in scrapeURL's
// ESM-heavy module graph.
export function shouldCheckRobots(
  options: { lockdown?: boolean },
  internalOptions: { teamFlags?: TeamFlags; safeMode?: ResolvedSafeMode },
): boolean {
  if (options.lockdown) {
    return false;
  }
  if (internalOptions.safeMode?.enforceRobots) {
    return true;
  }
  return !!internalOptions.teamFlags?.checkRobotsOnScrape;
}
