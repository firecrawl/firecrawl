import type { Meta } from ".";
import type { TeamFlags } from "../../controllers/v1/types";
import { isWikimediaUrl, useWikipedia } from "./engines/wikipedia";

// The invariant "lockdown never fetches robots.txt" is load-bearing for the
// lockdown guarantee (robots.txt is a request to the target domain). Keep this
// in its own file so it can be unit-tested without dragging in scrapeURL's
// ESM-heavy module graph.
export function shouldCheckRobots(meta: Meta): boolean {
  if (useWikipedia && isWikimediaUrl(meta.rewrittenUrl ?? meta.url)) {
    return false;
  }
  if (meta.options.lockdown) {
    return false;
  }
  return !!meta.internalOptions.teamFlags?.checkRobotsOnScrape;
}
