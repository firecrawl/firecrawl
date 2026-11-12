import type { InitialFiles } from "just-bash";
import { logger } from "../logger";

const DOCS_ORIGIN = "https://docs.firecrawl.dev";
const INDEX_URL = `${DOCS_ORIGIN}/llms.txt`;
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const LINK = /\]\((https:\/\/docs\.firecrawl\.dev\/[^)\s]+)\)/g;

/** Docs text by URL, shared by every shell on this server for an hour. */
const cache = new Map<string, { at: number; text: Promise<string> }>();

function fetchText(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const text = fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then(res => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.text();
    })
    .catch(error => {
      // A failure is not cached, so the next read tries again.
      if (cache.get(url)?.text === text) cache.delete(url);
      throw error;
    });
  cache.set(url, { at: Date.now(), text });
  return text;
}

/**
 * Every English page path, found by walking llms.txt and its English
 * sub-indexes. An index that fails to load is skipped and reported, so the
 * pages found elsewhere are kept.
 */
async function walkIndexes(): Promise<{ pages: string[]; complete: boolean }> {
  const seen = new Set<string>();
  const pages = new Set<string>();
  let complete = true;
  const walk = async (url: string): Promise<void> => {
    if (seen.has(url)) return;
    seen.add(url);
    let index: string;
    try {
      index = await fetchText(url);
    } catch (error) {
      complete = false;
      logger.warn("Hosted bash could not load a docs index", {
        module: "hosted-bash",
        url,
        error,
      });
      return;
    }
    const links = [...index.matchAll(LINK)].map(m => m[1]);
    for (const link of links) {
      if (link.endsWith(".md")) pages.add(new URL(link).pathname);
    }
    await Promise.all(
      links
        .filter(
          link =>
            link.endsWith(".txt") &&
            new URL(link).pathname.startsWith("/_llms/en"),
        )
        .map(walk),
    );
  };
  await walk(INDEX_URL);
  return { pages: [...pages].sort(), complete };
}

let known: string[] | null = null;
let refreshAt = 0;
let refresh: Promise<string[]> | null = null;

/**
 * The page list, refreshed hourly in the background. A command only waits for
 * it on a server that has never listed the docs; after that a slow or failing
 * docs site leaves the last list in place and is retried a minute later.
 */
function listPages(): Promise<string[]> {
  if (!refresh && Date.now() >= refreshAt) {
    refresh = walkIndexes()
      .then(({ pages, complete }) => {
        refreshAt = Date.now() + (complete ? TTL_MS : RETRY_MS);
        // A partial walk never replaces a fuller list.
        if (complete || pages.length >= (known?.length ?? 0)) known = pages;
        return known ?? pages;
      })
      .finally(() => {
        refresh = null;
      });
  }
  return known ? Promise.resolve(known) : (refresh as Promise<string[]>);
}

/**
 * The live docs.firecrawl.dev pages as files under /docs. Only the page list is
 * needed to start a shell; a page is fetched when a command first reads it.
 */
export async function docsFiles(): Promise<InitialFiles> {
  const files: InitialFiles = { "/docs/llms.txt": () => fetchText(INDEX_URL) };
  for (const path of await listPages().catch(() => [])) {
    files[`/docs${path}`] = () => fetchText(`${DOCS_ORIGIN}${path}`);
  }
  return files;
}
