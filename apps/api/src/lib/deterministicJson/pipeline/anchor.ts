// Build focused HTML context: locate each picked snippet in the raw HTML, climb
// to a budgeted ancestor subtree, simplify it, and stitch the windows together,
// with a document-unique selector hint per snippet. Falls back to simplifying the
// whole page when no snippet lands.
import {
  ANCHOR_MAX_BLOCKS,
  ANCHOR_MAX_PARENTS,
  ANCHOR_PER_BLOCK_BUDGET,
  ANCHOR_TOTAL_BUDGET,
  HTML_BUDGET,
} from "../config";
import { CostTracking } from "../../cost-tracking";
import { parseDocument } from "../html/dom";
import { pickSnippets } from "../llm/client";
import { buildAnchorPickerMessages } from "../llm/prompts";
import { simplifyHtml } from "../html/simplify";
import { errorMessage, log } from "../core/util";

export async function buildAnchorContext(
  args: {
    html: string;
    markdownPreview: string;
    schemaJson: string;
    prompt: string;
  },
  costTracking: CostTracking,
): Promise<string> {
  let snippets: string[] = [];
  try {
    snippets = await pickSnippets(
      buildAnchorPickerMessages({
        userPrompt: args.prompt,
        schemaJson: args.schemaJson,
        markdownPreview: args.markdownPreview,
      }),
      costTracking,
    );
    log(`anchor-picker chose ${snippets.length} snippet(s)`);
  } catch (err) {
    log(
      "anchor-picker failed, falling back to whole-page simplify:",
      errorMessage(err),
    );
  }

  const built = snippets.length ? buildAnchorHtml(args.html, snippets) : "";
  if (built.trim()) return built;

  log("no anchors landed; simplifying whole page");
  return simplifyHtml(args.html, { maxTotalLen: HTML_BUDGET });
}

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

// The picker reads markdown, so snippets often carry markdown decoration
// ("- **Foo**", "## Bar", "`baz`") that never appears in rendered HTML text.
// Strip it so the bare text matches the DOM.
function stripMarkdown(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s+|#+\s+)/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

// Deepest element whose normalized text contains the needle - the leaf that
// actually holds the snippet, so we can climb from a tight starting point.
function findDeepestMatch(root: Element, needle: string): Element | null {
  let best: Element | null = null;
  const visit = (el: Element): boolean => {
    if (!normalize(el.textContent ?? "").includes(needle)) return false;
    let inChild = false;
    for (const child of Array.from(el.children))
      if (visit(child)) inChild = true;
    if (!inChild) best = el;
    return true;
  };
  visit(root);
  return best;
}

function ownText(el: Element): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    out +=
      child.nodeType === 3
        ? (child.textContent ?? "")
        : " " + (child.textContent ?? "");
  }
  return out;
}

// How many distinct (non-nested) elements own text containing the needle -
// signals when a snippet is too generic to anchor on.
function countMatches(root: Element, needle: string): number {
  const matches = Array.from(root.querySelectorAll("*")).filter(el =>
    normalize(ownText(el)).includes(needle),
  );
  return matches.filter(el => !matches.some(o => o !== el && o.contains(el)))
    .length;
}

function climbToBudget(anchor: Element): Element {
  let current = anchor;
  for (let i = 0; i < ANCHOR_MAX_PARENTS; i++) {
    const parent = current.parentElement;
    if (!parent || parent.tagName === "BODY" || parent.tagName === "HTML")
      break;
    if ((parent.outerHTML ?? "").length > ANCHOR_PER_BLOCK_BUDGET) break;
    current = parent;
  }
  return current;
}

const STABLE_ATTRS = ["itemprop", "data-testid", "data-test", "role", "name"];
const cssEscape = (s: string): string => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");

function isStableClass(c: string): boolean {
  if (/^[a-z-]+-\[?[\d.]/.test(c)) return false; // utility e.g. h-[14px], pr-1.5
  if (/[A-Za-z]_[A-Za-z0-9]{4,}$/.test(c)) return false; // CSS-module hash
  if (/^(is-|has-|js-|active|selected|hidden|open)/.test(c)) return false; // state
  return c.length >= 2;
}

// A selector fragment that targets this element by a stable hook (id, semantic
// attribute, or stable class), or null. Not checked for uniqueness on its own.
function ownHook(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${tag}[${attr}="${v}"]`;
  }
  const classes = Array.from(el.classList).filter(isStableClass);
  if (classes.length)
    return tag + classes.map(c => `.${cssEscape(c)}`).join("");
  return null;
}

// Find a CSS selector that returns exactly this element on the whole document,
// or null. Tries the element's own hook first, then scopes by an ancestor's hook
// (page text often sits in attribute-less spans whose ancestor carries the id).
function uniqueSelector(doc: Document, el: Element): string | null {
  const matchesOne = (sel: string): boolean => {
    try {
      return (
        doc.querySelectorAll(sel).length === 1 && doc.querySelector(sel) === el
      );
    } catch {
      return false;
    }
  };

  const tag = el.tagName.toLowerCase();

  // 1. The element's own hook, narrowing the class chain until it's unique.
  const id = el.getAttribute("id");
  if (id && /^[A-Za-z][\w-]*$/.test(id) && matchesOne(`#${id}`))
    return `#${id}`;
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && matchesOne(`${tag}[${attr}="${v}"]`))
      return `${tag}[${attr}="${v}"]`;
  }
  const classes = Array.from(el.classList).filter(isStableClass);
  for (let n = 1; n <= classes.length; n++) {
    const sel =
      tag +
      classes
        .slice(0, n)
        .map(c => `.${cssEscape(c)}`)
        .join("");
    if (matchesOne(sel)) return sel;
  }

  // 2. Scope by an ancestor's hook: `<ancestorHook> <leafTag(.class)>`.
  const leafForms = [
    tag,
    classes[0] ? `${tag}.${cssEscape(classes[0])}` : "",
  ].filter(Boolean);
  let ancestor = el.parentElement;
  for (
    let depth = 0;
    ancestor && depth < 5;
    depth++, ancestor = ancestor.parentElement
  ) {
    const hook = ownHook(ancestor);
    if (!hook) continue;
    for (const leaf of leafForms) {
      if (matchesOne(`${hook} ${leaf}`)) return `${hook} ${leaf}`;
    }
  }
  return null;
}

function anchorsHeader(hints: { snippet: string; selector: string }[]): string {
  if (!hints.length) return "";
  const lines = hints.map(
    h => `  ${JSON.stringify(h.snippet)} -> ${h.selector}`,
  );
  return (
    `<!-- VERIFIED SELECTORS: each returns exactly one element on the full page.\n` +
    `     Your code runs against the whole document, so prefer these for the\n` +
    `     fields they name. -->\n` +
    lines.join("\n") +
    "\n\n"
  );
}

// simplifyHtml serializes a full <html> shell; we only want the body contents.
function unwrapBody(html: string): string {
  const open = html.match(/<body[^>]*>/i);
  if (!open) return html;
  const start = (open.index ?? 0) + open[0].length;
  const end = html.lastIndexOf("</body>");
  return end < start ? html.slice(start) : html.slice(start, end);
}

function buildAnchorHtml(rawHtml: string, snippets: string[]): string {
  const doc = parseDocument(rawHtml);
  const root = (doc.body ?? doc.documentElement) as Element;

  const emittedSubtrees = new Set<Element>();
  const seenHtml = new Set<string>();
  const hints: { snippet: string; selector: string }[] = [];
  let combined = "";
  let blocks = 0;

  for (const raw of snippets) {
    const snippet = normalize(stripMarkdown(raw));
    if (!snippet) continue;

    const anchor = findDeepestMatch(root, snippet);
    if (!anchor) continue;

    const selector = uniqueSelector(doc, anchor);
    if (selector) hints.push({ snippet: snippet.slice(0, 80), selector });

    // Skip if a window we already emitted contains this anchor.
    if ([...emittedSubtrees].some(prior => prior.contains(anchor))) continue;
    if (blocks >= ANCHOR_MAX_BLOCKS) continue;

    const subtree = climbToBudget(anchor);
    const simplified = unwrapBody(
      simplifyHtml(subtree.outerHTML ?? "", {
        maxTotalLen: ANCHOR_PER_BLOCK_BUDGET,
      }),
    ).trim();
    if (!simplified || seenHtml.has(simplified)) continue;

    const matches = countMatches(root, snippet);
    const note = matches > 1 ? ` (${matches} similar matches on the page)` : "";
    const piece = `<!-- anchor ${blocks + 1}: ${JSON.stringify(snippet.slice(0, 120))}${note} -->\n${simplified}\n`;
    if (combined.length + piece.length > ANCHOR_TOTAL_BUDGET && blocks > 0)
      break;

    emittedSubtrees.add(subtree);
    seenHtml.add(simplified);
    combined += piece;
    blocks += 1;
  }

  log(`anchor-html: ${blocks} window(s), ${hints.length} verified selector(s)`);
  return combined ? anchorsHeader(hints) + combined : "";
}
