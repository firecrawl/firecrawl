import type { MapDocument } from "../controllers/v2/types";
import {
  generateDomainSplits,
  generateURLSplits,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta,
} from "../services/index";

export async function queryIndex(
  url: string,
  limit: number,
  useIndex: boolean,
  includeSubdomains: boolean,
): Promise<MapDocument[]> {
  if (!useIndex) {
    return [];
  }

  const urlSplits = generateURLSplits(url);
  if (urlSplits.length === 1 && includeSubdomains) {
    const hostname = new URL(urlSplits[0]).hostname;
    const domainSplits = generateDomainSplits(hostname);
    // domain_splits_0..4_hash cover hosts with a registrable domain up to 5
    // levels; IP literals, localhost, and deeper subdomains fall back to
    // url_split_0_hash.
    if (domainSplits.length > 0 && domainSplits.length <= 5) {
      return await queryIndexAtDomainSplitLevelWithMeta(hostname, limit);
    }
  }

  return await queryIndexAtSplitLevelWithMeta(url, limit);
}
