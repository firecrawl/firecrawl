/**
 * Extract a small chunk of HTML from the top/header area for LLM context when
 * no logo candidates were found. Helps the LLM infer brand name and note that
 * a logo may exist but wasn't captured (e.g. inline SVG, shadow DOM).
 *
 * Strategy: strip noise, find header/nav/body start, take first N chars.
 */

const MAX_HEADER_CHUNK_CHARS = 5500;

/**
 * Remove script and style tags and their content, and HTML comments.
 * Uses regex; safe for typical page header content.
 */
function stripNoise(html: string): string {
  let out = html;
  // Comments
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  // Scripts (non-greedy to first </script>)
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  // Styles
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  return out;
}

/**
 * Find the earliest start of header-like content: <header, <nav, or <body.
 * Returns index into html, or 0 if not found.
 */
function findHeaderStart(html: string): number {
  const lower = html.toLowerCase();
  const header = lower.indexOf("<header");
  const nav = lower.indexOf("<nav");
  const body = lower.indexOf("<body");
  const indices = [header, nav, body].filter(i => i >= 0);
  return indices.length > 0 ? Math.min(...indices) : 0;
}

/**
 * Extract a single chunk of HTML useful for logo/brand context: header/nav
 * area, stripped of scripts/styles/comments, length-limited.
 * Use only when there are no logo candidates so the LLM has fallback context.
 */
export function extractHeaderHtmlChunk(html: string): string {
  if (!html || typeof html !== "string") return "";
  const stripped = stripNoise(html);
  const start = findHeaderStart(stripped);
  const chunk = stripped.slice(start, start + MAX_HEADER_CHUNK_CHARS);
  return chunk.replace(/\s+/g, " ").trim();
}
