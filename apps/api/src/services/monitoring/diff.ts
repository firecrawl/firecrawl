import { createMarkdownChangeDiff } from "../../lib/change-tracking-diff";

type MonitorMarkdownDiffResult =
  | {
      kind: "markdown";
      status: "same";
      text?: undefined;
      json?: undefined;
    }
  | {
      kind: "markdown";
      status: "changed";
      text: string;
      json: {
        files: Array<{
          from: string | null;
          to: string | null;
          chunks: Array<{
            content: string;
            changes: Array<{
              type: string;
              normal?: boolean;
              add?: boolean;
              del?: boolean;
              ln?: number;
              ln1?: number;
              ln2?: number;
              content: string;
            }>;
          }>;
        }>;
      };
    };

type MonitorJsonDiffResult =
  | { kind: "json"; status: "same"; json?: undefined }
  | {
      kind: "json";
      status: "changed";
      json: Record<string, { previous: unknown; current: unknown }>;
    };

type MonitoringDiffResult = MonitorMarkdownDiffResult;

function normalizeMarkdownForChangeTracking(markdown: string): string {
  return [...markdown.replace(/\s+/g, "").replace(/\[iframe\]\(.+?\)/g, "")]
    .sort()
    .join("");
}

export function diffMonitorMarkdown(
  previousMarkdown: string,
  currentMarkdown: string,
): MonitoringDiffResult {
  if (
    normalizeMarkdownForChangeTracking(previousMarkdown) ===
    normalizeMarkdownForChangeTracking(currentMarkdown)
  ) {
    return { kind: "markdown", status: "same" };
  }

  const diff = createMarkdownChangeDiff(previousMarkdown, currentMarkdown);

  return {
    kind: "markdown",
    status: "changed",
    text: diff?.text ?? "",
    json: diff?.json ?? { files: [] },
  };
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    // For JSON-extraction monitor diffs we treat strings as semantically
    // equal when they differ only in whitespace. LLM extractions are
    // routinely inconsistent about incidental whitespace between runs
    // — extra spaces, trailing newlines, NBSP (U+00A0), BOM, zero-width
    // characters from HTML rendering — and reporting those as changes
    // drowns out the signal from real content changes (price, headline,
    // status flag, etc.). Users who need whitespace fidelity should
    // monitor markdown, not JSON.
    //
    // Steps:
    //   1. NFC normalize so `é` and `e\u0301` compare equal.
    //   2. Strip zero-width chars that `\s` doesn't match (ZWSP, ZWNJ,
    //      ZWJ, BOM).
    //   3. Collapse every run of whitespace (incl. \n, \t, NBSP) to a
    //      single space.
    //   4. Trim.
    return value
      .normalize("NFC")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return value;
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
  const na = normalizeJsonValue(a);
  const nb = normalizeJsonValue(b);
  if (na === nb) return true;
  if (typeof na !== typeof nb) return false;
  if (na && nb && typeof na === "object") {
    // Deep, key-order-independent equality. Using JSON.stringify here would
    // report a spurious diff whenever the LLM returned the same fields in a
    // different order between runs.
    if (Array.isArray(na) || Array.isArray(nb)) {
      if (!Array.isArray(na) || !Array.isArray(nb)) return false;
      if (na.length !== nb.length) return false;
      for (let i = 0; i < na.length; i++) {
        if (!jsonValuesEqual(na[i], nb[i])) return false;
      }
      return true;
    }
    const aKeys = Object.keys(na as Record<string, unknown>);
    const bKeys = Object.keys(nb as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(nb, k)) return false;
      if (
        !jsonValuesEqual(
          (na as Record<string, unknown>)[k],
          (nb as Record<string, unknown>)[k],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinKey(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function joinIndex(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/**
 * Walk two JSON subtrees in parallel and append a `{previous, current}`
 * entry to `out` for every leaf-level difference. Keys in `out` are
 * dotted/bracketed JSON paths (e.g. `plans[0].price`, `metadata.title`).
 *
 * When both values at a node are objects (or both arrays) we recurse so
 * unchanged sibling fields aren't reported as part of the diff. When the
 * types diverge (object vs primitive, array vs null, …) we record the
 * whole subtree as a single change at the current path — splitting it
 * further would be lossy/misleading.
 */
function collectJsonFieldDiffs(
  prev: unknown,
  curr: unknown,
  path: string,
  out: Record<string, { previous: unknown; current: unknown }>,
): void {
  if (jsonValuesEqual(prev, curr)) return;

  if (isPlainObject(prev) && isPlainObject(curr)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
    for (const key of keys) {
      collectJsonFieldDiffs(prev[key], curr[key], joinKey(path, key), out);
    }
    return;
  }

  if (Array.isArray(prev) && Array.isArray(curr)) {
    const len = Math.max(prev.length, curr.length);
    for (let i = 0; i < len; i++) {
      collectJsonFieldDiffs(prev[i], curr[i], joinIndex(path, i), out);
    }
    return;
  }

  out[path] = { previous: prev, current: curr };
}

/**
 * Diff two JSON snapshots (current vs previous scrape `doc.json`) for a
 * monitor. Returns `same` if every field is unchanged after NFC
 * normalization, otherwise `changed` with a per-path `{previous, current}`
 * map containing only the leaf-level fields that differ. Paths use
 * dot/bracket notation, e.g. `plans[0].price` or `metadata.title`, so a
 * single nested mutation doesn't render the entire parent object as
 * changed in the UI.
 */
export function diffMonitorJson(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
): MonitorJsonDiffResult {
  const prev = previous ?? {};
  const curr = current ?? {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const diff: Record<string, { previous: unknown; current: unknown }> = {};

  for (const key of keys) {
    collectJsonFieldDiffs(prev[key], curr[key], key, diff);
  }

  if (Object.keys(diff).length === 0) {
    return { kind: "json", status: "same" };
  }
  return { kind: "json", status: "changed", json: diff };
}

/**
 * True iff the monitor's scrapeOptions.formats requests a git-diff style
 * markdown diff via a `{type:"changeTracking", modes:[...,"git-diff",...]}`
 * format. Plain `"markdown"` does not count — that's the default scrape
 * output and the markdown-diff path runs whenever JSON extraction wasn't
 * requested.
 */
export function formatsRequestGitDiff(formats: unknown): boolean {
  if (!Array.isArray(formats)) return false;
  for (const entry of formats) {
    if (entry && typeof entry === "object") {
      const obj = entry as { type?: unknown; modes?: unknown };
      if (obj.type === "changeTracking") {
        const modes = Array.isArray(obj.modes) ? obj.modes : [];
        if (modes.includes("git-diff")) return true;
      }
    }
  }
  return false;
}

/**
 * True iff the monitor's scrapeOptions.formats requests JSON extraction —
 * either as a plain `{type:"json"}` format or as a change-tracking format
 * with `"json"` in its modes.
 */
export function formatsRequestJsonExtraction(formats: unknown): boolean {
  if (!Array.isArray(formats)) return false;
  for (const entry of formats) {
    if (typeof entry === "string" && entry === "json") return true;
    if (entry && typeof entry === "object") {
      const obj = entry as { type?: unknown; modes?: unknown };
      // Both json and deterministicJson populate document.json, so the JSON
      // diff path applies to either.
      if (obj.type === "json" || obj.type === "deterministicJson") return true;
      if (obj.type === "changeTracking") {
        const modes = Array.isArray(obj.modes) ? obj.modes : [];
        if (modes.includes("json")) return true;
      }
    }
  }
  return false;
}

/**
 * Collapse monitor-level format shorthand into what the scrape engine
 * understands. Today the runner owns history; we always want the scrape to
 * return current values via the plain `{type:"json"}` format. A
 * `{type:"changeTracking", modes:["json"], schema, prompt}` entry becomes
 * `{type:"json", schema, prompt}`; if the user asked for `git-diff` mode in
 * addition, that mode is dropped (markdown is already requested elsewhere).
 */
export function normalizeMonitorFormats(formats: unknown): unknown[] {
  if (!Array.isArray(formats)) return [];
  const out: unknown[] = [];
  for (const entry of formats) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "changeTracking"
    ) {
      const obj = entry as {
        type: "changeTracking";
        modes?: unknown;
        schema?: unknown;
        prompt?: unknown;
        tag?: unknown;
      };
      const modes = Array.isArray(obj.modes) ? obj.modes : [];
      if (modes.includes("json")) {
        out.push({
          type: "json",
          ...(typeof obj.prompt === "string" ? { prompt: obj.prompt } : {}),
          ...(obj.schema && typeof obj.schema === "object"
            ? { schema: obj.schema }
            : {}),
        });
      }
      // git-diff mode is implicit via the markdown format already added.
      continue;
    }
    out.push(entry);
  }
  return out;
}
