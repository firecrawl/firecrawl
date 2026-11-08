import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v1/types";

// The invariant "lockdown never fetches robots.txt" is load-bearing for the
// lockdown guarantee (robots.txt is a request to the target domain). Keep this
// in its own file so it can be unit-tested without dragging in scrapeURL's
// ESM-heavy module graph.
export function shouldCheckRobots(
  options: { lockdown?: boolean },
  internalOptions: { teamFlags?: TeamFlags },
): boolean {
  if (config.FAST_CRAWL === true) {
    return false;
  }
  if (options.lockdown) {
    return false;
  }
  return !!internalOptions.teamFlags?.checkRobotsOnScrape;
}
