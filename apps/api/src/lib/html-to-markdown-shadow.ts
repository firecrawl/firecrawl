import type { Logger } from "winston";
import { convertHtmlToMarkdownSimd } from "@mendable/firecrawl-rs";

// Extract content words from markdown, stripping syntax
function extractWords(md: string): Set<string> {
  return new Set(
    md
      .replace(/```[\s\S]*?```/g, " ") // strip code blocks (keep words outside)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // strip images (before links)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/[#*_~`|>\-\[\]()\\]/g, " ") // strip markdown punctuation
      .replace(/https?:\/\/\S+/g, " ") // strip bare URLs
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

// Parse markdown table cells as flat array of trimmed cell text
function extractTableCells(md: string): string[] {
  const cells: string[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[\s\-:|]+\|$/.test(trimmed)) continue; // skip separators
    for (const cell of trimmed.split("|").slice(1, -1)) {
      const text = cell.trim();
      if (text) cells.push(text.toLowerCase());
    }
  }
  return cells;
}

// Count structural markdown elements
function countStructure(md: string) {
  return {
    headings: (md.match(/^#{1,6}\s/gm) || []).length,
    links: (md.match(/\[[^\]]+\]\([^)]+\)/g) || []).length,
    codeBlocks: (md.match(/^```/gm) || []).length / 2,
    images: (md.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length,
    listItems: (md.match(/^[\s]*[-*+]\s|^[\s]*\d+\.\s/gm) || []).length,
  };
}

export async function shadowSimdConversion(
  html: string,
  goResult: string,
  goDurationMs: number,
  contextLogger: Logger,
  requestId?: string,
) {
  try {
    const start = performance.now();
    const simdResult = await convertHtmlToMarkdownSimd(html);
    const durationMs = performance.now() - start;

    // Word coverage: are all content words from Go present in SIMD?
    const goWords = extractWords(goResult);
    const simdWords = extractWords(simdResult);
    const missingWords: string[] = [];
    for (const w of goWords) {
      if (!simdWords.has(w)) missingWords.push(w);
    }
    const wordCoverage =
      goWords.size > 0 ? 1 - missingWords.length / goWords.size : 1;

    // Table cell comparison
    const goCells = extractTableCells(goResult);
    const simdCells = extractTableCells(simdResult);
    const simdCellSet = new Set(simdCells);
    const missingCells = goCells.filter((c) => !simdCellSet.has(c));
    const tableCellCoverage =
      goCells.length > 0 ? 1 - missingCells.length / goCells.length : 1;

    // Structural comparison
    const goStruct = countStructure(goResult);
    const simdStruct = countStructure(simdResult);

    const match = wordCoverage >= 0.95 && tableCellCoverage >= 0.95;

    contextLogger.info("simd-shadow", {
      module: "html-to-markdown",
      shadow: true,
      match,
      simdMs: Math.round(durationMs * 100) / 100,
      goMs: Math.round(goDurationMs * 100) / 100,
      speedup: goDurationMs > 0 ? Math.round((goDurationMs / durationMs) * 10) / 10 : 0,
      htmlLen: html.length,
      goLen: goResult.length,
      simdLen: simdResult.length,
      tokenSavings: goResult.length - simdResult.length,
      wordCoverage: Math.round(wordCoverage * 1000) / 1000,
      missingWordCount: missingWords.length,
      missingWordSample: missingWords.slice(0, 10).join(", "),
      tableCellCoverage: Math.round(tableCellCoverage * 1000) / 1000,
      missingCellCount: missingCells.length,
      tableCountGo: goCells.length,
      tableCountSimd: simdCells.length,
      headingDiff: simdStruct.headings - goStruct.headings,
      linkDiff: simdStruct.links - goStruct.links,
      codeBlockDiff: simdStruct.codeBlocks - goStruct.codeBlocks,
      imageDiff: simdStruct.images - goStruct.images,
      listItemDiff: simdStruct.listItems - goStruct.listItems,
      ...(requestId ? { requestId } : {}),
    });
  } catch (error) {
    contextLogger.error("simd-shadow: error", {
      module: "html-to-markdown",
      shadow: true,
      error: error instanceof Error ? error.message : String(error),
      ...(requestId ? { requestId } : {}),
    });
  }
}
