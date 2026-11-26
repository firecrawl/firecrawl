import type { RequestContext } from "../../service/request-context";

// The invariant "lockdown never fetches robots.txt" is load-bearing for the
// lockdown guarantee (robots.txt is a request to the target domain). Keep this
// in its own file so it can be unit-tested without dragging in scrapeURL's
// ESM-heavy module graph.
export function shouldCheckRobots(
  options: { lockdown?: boolean },
  ctx?: Pick<RequestContext, "checkRobotsOnScrape" | "lockdown" | "flags">,
): boolean {
  if (options.lockdown || ctx?.lockdown) {
    return false;
  }
  return (
    ctx?.checkRobotsOnScrape === true ||
    ctx?.flags?.checkRobotsOnScrape === true
  );
}
