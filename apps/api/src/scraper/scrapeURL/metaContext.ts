import type { ScrapeMeta, ScrapeState } from "../../service/hooks";
import type { Meta } from ".";

const metaByState = new WeakMap<ScrapeState, Meta>();

export function bindScrapeMeta(state: ScrapeState, meta: Meta): void {
  metaByState.set(state, meta);
}

/**
 * Returns the live scrape pipeline `Meta` associated with a hook's `ScrapeMeta`.
 * Unstable internal escape hatch for extensions that inspect or update pipeline
 * metadata outside the stable `ScrapeMeta` contract.
 */
export function getScrapeMeta(info: ScrapeMeta): Meta | undefined {
  return metaByState.get(info.state);
}
