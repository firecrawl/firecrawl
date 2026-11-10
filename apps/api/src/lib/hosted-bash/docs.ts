import type { InitialFiles } from "just-bash";

const DOCS_ORIGIN = "https://docs.firecrawl.dev";
const INDEX_URL = `${DOCS_ORIGIN}/llms.txt`;
const TTL_MS = 60 * 60 * 1000;
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

/** Every English page path, found by walking llms.txt and its English sub-indexes. */
async function listPages(): Promise<string[]> {
  const seen = new Set<string>();
  const pages = new Set<string>();
  const walk = async (url: string): Promise<void> => {
    if (seen.has(url)) return;
    seen.add(url);
    const links = [...(await fetchText(url)).matchAll(LINK)].map(m => m[1]);
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
  return [...pages].sort();
}

/**
 * The live docs.firecrawl.dev pages as files under /docs. Only the page list is
 * loaded up front; a page is fetched when a command first reads it. If the docs
 * site is down the shell still starts, with an empty /docs.
 */
export async function docsFiles(): Promise<InitialFiles> {
  const files: InitialFiles = { "/docs/llms.txt": () => fetchText(INDEX_URL) };
  for (const path of await listPages().catch(() => [])) {
    files[`/docs${path}`] = () => fetchText(`${DOCS_ORIGIN}${path}`);
  }
  return files;
}
