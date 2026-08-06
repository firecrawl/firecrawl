// Link discovery normally parses HTML anchors, but text/plain bodies (e.g.
// llms.txt) carry their links as markdown/bare-URL syntax that the HTML
// extractor never sees. This pulls http(s) targets out of such a body so
// crawl and the links format can follow them, resolving relative targets
// against the source URL.

// [text](url) and [text](url "title"); target may be wrapped in <>.
const INLINE_LINK =
  /\]\(\s*(<[^>\s]+>|[^)\s]+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// <https://...> autolinks.
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/gi;
// Bare URLs not already captured inside (), [] or <>.
const BARE_URL = /(?<![\](<])https?:\/\/[^\s<>()\[\]"']+/gi;

export function extractMarkdownLinks(text: string, baseUrl: string): string[] {
  const links = new Set<string>();

  const add = (raw: string) => {
    let href = raw.trim();
    if (href.startsWith("<") && href.endsWith(">")) {
      href = href.slice(1, -1).trim();
    }
    href = href.replace(/[.,;:]+$/, "");
    if (!href || href.startsWith("#")) {
      return;
    }
    try {
      const resolved = new URL(href, baseUrl).href;
      if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
        links.add(resolved);
      }
    } catch {
      // ignore unparseable link targets
    }
  };

  for (const m of text.matchAll(INLINE_LINK)) add(m[1]);
  for (const m of text.matchAll(AUTOLINK)) add(m[1]);
  for (const m of text.matchAll(BARE_URL)) add(m[0]);

  return [...links];
}
