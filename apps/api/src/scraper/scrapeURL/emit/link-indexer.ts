import type { Document } from "../../../controllers/v2/types";
import type { Meta } from "../context";
import { config } from "../../../config";
import { indexerQueue } from "../../../services/indexing/indexer-queue";
import { extractLinks } from "../lib/html/extract-links";

/**
 * Forward a sampled fraction of scrapes' outbound links to the indexer queue.
 * Extracts links lazily if `derive` didn't (i.e. the caller didn't request the
 * `links` format). No-op when traffic share is 0, the team is internal, or the
 * document has no HTML.
 */
export async function forwardLinksToIndexer(
  meta: Meta,
  document: Document,
): Promise<void> {
  const rate = config.INDEXER_TRAFFIC_SHARE
    ? Math.max(0, Math.min(1, Number(config.INDEXER_TRAFFIC_SHARE)))
    : 0;
  if (rate === 0 || Math.random() > rate || !config.INDEXER_RABBITMQ_URL) {
    return;
  }

  const teamId = meta.internalOptions.teamId;
  if (!teamId || teamId.includes("robots-txt") || teamId.includes("sitemap")) {
    return;
  }

  if (!document.html) return;

  const baseUrl =
    document.metadata.url ?? document.metadata.sourceURL ?? meta.url;
  const links = document.links ?? (await extractLinks(document.html, baseUrl));
  if (links.length === 0) return;

  indexerQueue
    .sendToWorker({
      id: meta.id,
      type: "links",
      discovery_url: baseUrl,
      urls: [...new Set(links)],
    })
    .catch(error => {
      meta.logger.error("Failed to queue links for indexing", {
        error: (error as Error)?.message,
        url: meta.url,
      });
    });
}
