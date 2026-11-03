import { config } from "../../../config";
import { sampled } from "../../../lib/rollout";

/** Share of the page's text above which a cleaning result carries a warning. */
export const REMOVED_SHARE_WARNING_THRESHOLD = 0.7;

export type CleanContentRoute = "legacy" | "shadow" | "deletion";

/**
 * Picks the onlyCleanContent implementation for one request. "on" samples by
 * team so a team stays on one side of the ramp; "shadow" samples per request.
 */
export function selectCleanContentRoute(
  teamId: string | undefined,
  random: () => number = Math.random,
): CleanContentRoute {
  const percent = config.ONLY_CLEAN_CONTENT_PERCENT;
  switch (config.ONLY_CLEAN_CONTENT_MODE) {
    case "on":
      return sampled(`onlyCleanContent:${teamId}`, percent)
        ? "deletion"
        : "legacy";
    case "shadow":
      return random() * 100 < percent ? "shadow" : "legacy";
    default:
      return "legacy";
  }
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;
const TABLE_DELIMITER = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?)?\s*$/;

/**
 * Splits markdown into blocks separated by blank lines. A fenced code block
 * always stays inside one block, blank lines included.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (const line of markdown.split("\n")) {
    const marker = line.match(FENCE)?.[1];
    if (marker) {
      if (fence === null) {
        const inlineCode =
          marker[0] === "`" && line.trim().slice(marker.length).includes("`");
        if (!inlineCode) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = null;
      }
    } else if (fence === null && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  return blocks;
}

/** Headings, fenced code and tables, which cleaning never removes. */
export function isProtectedBlock(block: string): boolean {
  const lines = block.split("\n");
  return lines.some(
    (line, i) =>
      FENCE.test(line) ||
      ATX_HEADING.test(line) ||
      (i > 0 && lines[i - 1].trim() !== "" && SETEXT_UNDERLINE.test(line)) ||
      (line.includes("|") && TABLE_DELIMITER.test(line)),
  );
}

const ANCHOR_LINK = /\s*\[([^\]]*)\]\(([^)\s]*#[^)\s]*)(?:\s+"[^"]*")?\)/g;
const ANCHOR_LABEL =
  /^\s*(copy link( to (this )?(section|heading))?|link to (this )?(section|heading)|direct link to .*|permalink|anchor|#|¶|§|🔗)?\s*$/i;

/**
 * Removes "Copy link to section"-style anchor links from heading lines. The
 * heading's own text, links included, is kept as is.
 */
export function stripHeadingAnchorLinks(block: string): string {
  const lines = block.split("\n");
  if (lines.some(line => FENCE.test(line))) return block;
  return lines
    .map(line => {
      if (!ATX_HEADING.test(line)) return line;
      return line
        .replace(ANCHOR_LINK, (link, label: string) =>
          ANCHOR_LABEL.test(label) ? "" : link,
        )
        .replace(/^(\s{0,3}#{1,6})\s+/, "$1 ")
        .trimEnd();
    })
    .join("\n");
}

export type BlockRemovalStats = {
  totalBlocks: number;
  removedBlocks: number;
  protectedHits: number;
  removedShare: number;
};

/**
 * Rebuilds the page from the blocks the model did not ask to remove. Ids that
 * point at protected blocks are ignored and counted. When nothing is removed,
 * or everything would be, the original markdown is returned.
 */
export function applyBlockRemovals(
  original: string,
  blocks: string[],
  removeIds: unknown,
): { markdown: string; warning?: string; stats: BlockRemovalStats } {
  const removed = new Set<number>();
  let protectedHits = 0;
  for (const id of Array.isArray(removeIds) ? new Set(removeIds) : []) {
    if (!Number.isInteger(id) || id < 0 || id >= blocks.length) continue;
    if (isProtectedBlock(blocks[id])) protectedHits++;
    else removed.add(id);
  }

  const totalChars = blocks.reduce((sum, block) => sum + block.length, 0);
  const removedChars = [...removed].reduce(
    (sum, id) => sum + blocks[id].length,
    0,
  );
  const stats: BlockRemovalStats = {
    totalBlocks: blocks.length,
    removedBlocks: removed.size,
    protectedHits,
    removedShare: totalChars > 0 ? removedChars / totalChars : 0,
  };

  if (removed.size === 0) {
    return {
      markdown: original,
      warning:
        "Content cleaning found nothing to remove. The original markdown has been preserved.",
      stats,
    };
  }
  if (removed.size === blocks.length) {
    return {
      markdown: original,
      warning:
        "Content cleaning would have removed the whole page. The original markdown has been preserved.",
      stats,
    };
  }

  return {
    markdown: blocks.filter((_, i) => !removed.has(i)).join("\n\n"),
    warning:
      stats.removedShare > REMOVED_SHARE_WARNING_THRESHOLD
        ? `Content cleaning removed ${Math.round(stats.removedShare * 100)}% of the page's text. Check that the main content was kept.`
        : undefined,
    stats,
  };
}
