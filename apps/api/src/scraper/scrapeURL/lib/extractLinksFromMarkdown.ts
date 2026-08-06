const MARKDOWN_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
];

/** Bodies served as text but authored as markdown, e.g. llms.txt. */
export function isMarkdownContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return MARKDOWN_CONTENT_TYPES.some(type => normalized.includes(type));
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const INLINE_LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)/gm;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^>\s]+)>/g;
const BARE_URL = /(?:^|[\s(<])(https?:\/\/[^\s<>"'`)\]]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Blanks out fenced blocks and inline code spans. */
function stripCode(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);

    if (fence !== null) {
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length
      ) {
        fence = null;
      }
      out.push("");
      continue;
    }

    if (match) {
      fence = match[1];
      out.push("");
      continue;
    }

    out.push(line.replace(/`[^`\n]*`/g, " "));
  }

  return out.join("\n");
}

function resolve(href: string, baseUrl: string): string | null {
  let candidate = href.trim();

  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1).trim();
  }
  candidate = candidate.replace(TRAILING_PUNCTUATION, "");

  if (candidate === "" || candidate.startsWith("#")) {
    return null;
  }

  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return null;
  }
}

/** Extracts links from a markdown or plaintext body, excluding images. */
export function extractLinksFromMarkdown(
  text: string,
  baseUrl: string,
): string[] {
  const body = stripCode(text).replace(IMAGE, " ");
  const links: string[] = [];

  const push = (href: string) => {
    const resolved = resolve(href, baseUrl);
    if (resolved) {
      links.push(resolved);
    }
  };

  for (const match of body.matchAll(INLINE_LINK)) {
    push(match[1]);
  }
  for (const match of body.matchAll(REFERENCE_DEFINITION)) {
    push(match[1]);
  }
  for (const match of body.matchAll(AUTOLINK)) {
    push(match[1]);
  }
  for (const match of body.matchAll(BARE_URL)) {
    push(match[1]);
  }

  return [...new Set(links)];
}
