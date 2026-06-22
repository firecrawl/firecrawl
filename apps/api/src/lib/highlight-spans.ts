import * as marked from "marked";
import { decode as decodeHtmlEntities } from "he";

// Shared candidate-span generation + structure-aware reassembly for the
// query-highlights models. The query-finetuned highlight model (and the
// Fireworks gpt-oss-20b directQuote model) were trained on the line-like spans
// `parseMarkdownToSentences` produces, so BOTH the scrape `highlights` format
// and the search highlights beta must generate candidates here and reassemble
// selected indices with `assembleAnswer` — otherwise the model scores spans it
// never saw in training and the threshold stops meaning the same thing.

type SentenceSource = "heading" | "text" | "code" | "table";

interface Sentence {
  text: string;
  source: SentenceSource;
  blockId: number;
  lang?: string;
  isHeader?: boolean;
}

function extractInlineText(tokens: marked.Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out += (t as marked.Tokens.Text).tokens
          ? extractInlineText((t as marked.Tokens.Text).tokens!)
          : t.text;
        break;
      case "strong":
      case "em":
      case "del":
        out += extractInlineText(
          (t as marked.Tokens.Strong | marked.Tokens.Em | marked.Tokens.Del)
            .tokens,
        );
        break;
      case "link": {
        const linkToken = t as marked.Tokens.Link;
        const linkText = extractInlineText(linkToken.tokens);
        if (
          /^\[?\w{1,3}\]?$/.test(linkText) &&
          linkToken.href.includes("cite_note")
        )
          break;
        out += `[${linkText}](${linkToken.href})`;
        break;
      }
      case "image":
        if ((t as marked.Tokens.Image).text) {
          out += (t as marked.Tokens.Image).text;
        }
        break;
      case "codespan":
      case "escape":
        out += t.text;
        break;
      case "br":
        out += " ";
        break;
    }
  }
  return decodeHtmlEntities(out);
}

/**
 * Split markdown into the line-like candidate spans the highlight models were
 * trained on. Each span carries its source kind (heading/text/code/table),
 * a blockId grouping spans from the same source block, and table/code metadata
 * so `assembleAnswer` can reconstruct structure from the selected spans.
 */
export function parseMarkdownToSentences(markdown: string): Sentence[] {
  const result: Sentence[] = [];
  const tokens = marked.lexer(markdown);
  let blockId = 0;

  function pushSentences(text: string, source: SentenceSource, bid: number) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    for (const part of trimmed.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (s) result.push({ text: s, source, blockId: bid });
    }
  }

  function walkBlocks(tokens: marked.Token[]) {
    for (const token of tokens) {
      switch (token.type) {
        case "heading": {
          const bid = blockId++;
          const text = extractInlineText(
            (token as marked.Tokens.Heading).tokens,
          ).trim();
          if (text) result.push({ text, source: "heading", blockId: bid });
          break;
        }
        case "paragraph": {
          const bid = blockId++;
          pushSentences(
            extractInlineText((token as marked.Tokens.Paragraph).tokens),
            "text",
            bid,
          );
          break;
        }
        case "list": {
          for (const item of (token as marked.Tokens.List).items) {
            walkBlocks(item.tokens);
          }
          break;
        }
        case "blockquote": {
          walkBlocks((token as marked.Tokens.Blockquote).tokens);
          break;
        }
        case "table": {
          const bid = blockId++;
          const table = token as marked.Tokens.Table;
          const headerText = table.header
            .map(cell => extractInlineText(cell.tokens).trim())
            .filter(Boolean)
            .join(" | ");
          if (headerText)
            result.push({
              text: headerText,
              source: "table",
              blockId: bid,
              isHeader: true,
            });
          for (const row of table.rows) {
            const rowText = row
              .map(cell => extractInlineText(cell.tokens).trim())
              .filter(Boolean)
              .join(" | ");
            if (rowText)
              result.push({ text: rowText, source: "table", blockId: bid });
          }
          break;
        }
        case "code": {
          const bid = blockId++;
          const codeToken = token as marked.Tokens.Code;
          const lang = codeToken.lang || undefined;
          const lines = codeToken.text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed)
              result.push({
                text: trimmed,
                source: "code",
                blockId: bid,
                lang,
              });
          }
          break;
        }
        case "hr":
        case "space":
        case "html":
          break;
        default: {
          const bid = blockId++;
          if ("tokens" in token && Array.isArray(token.tokens)) {
            walkBlocks(token.tokens);
          } else if ("text" in token && typeof token.text === "string") {
            pushSentences(token.text, "text", bid);
          }
          break;
        }
      }
    }
  }

  walkBlocks(tokens);
  return result;
}

/**
 * Reassemble the spans the model selected (by index into the `parseMarkdown-
 * ToSentences` output) back into readable markdown. Structure-aware: a selected
 * table row pulls in its header and rebuilds the table syntax; consecutive code
 * spans rebuild a fenced block; same-block text spans rejoin into a paragraph.
 */
export function assembleAnswer(
  sentences: Sentence[],
  indices: number[],
): string {
  const selectedIndices = new Set(
    indices.filter(i => i >= 0 && i < sentences.length),
  );

  const tableHeaderIncluded = new Set<number>();
  for (const i of selectedIndices) {
    const s = sentences[i];
    if (
      s.source === "table" &&
      !s.isHeader &&
      !tableHeaderIncluded.has(s.blockId)
    ) {
      const headerIdx = sentences.findIndex(
        h => h.blockId === s.blockId && h.isHeader,
      );
      if (headerIdx !== -1) {
        selectedIndices.add(headerIdx);
        tableHeaderIncluded.add(s.blockId);
      }
    }
  }

  const selected = [...selectedIndices]
    .sort((a, b) => a - b)
    .map(i => ({ index: i, ...sentences[i] }));

  const parts: string[] = [];
  let codeRun: { texts: string[]; lang?: string } | null = null;

  function flushCode() {
    if (!codeRun) return;
    const fence = codeRun.lang ? "```" + codeRun.lang : "```";
    parts.push(fence + "\n" + codeRun.texts.join("\n") + "\n```");
    codeRun = null;
  }

  let tableRows: string[] | null = null;

  function formatTableRow(text: string): string {
    return "| " + text.split(" | ").join(" | ") + " |";
  }

  function startTable(cur: (typeof selected)[number]) {
    tableRows = [];
    if (cur.isHeader) {
      const cols = cur.text.split(" | ");
      const escaped = cols.map(c => c.replace(/\*/g, "\\*"));
      tableRows.push("| " + escaped.join(" | ") + " |");
      tableRows.push("| " + cols.map(() => "---").join(" | ") + " |");
    } else {
      tableRows.push(formatTableRow(cur.text));
    }
  }

  function appendTableRow(cur: (typeof selected)[number]) {
    if (!tableRows) {
      startTable(cur);
      return;
    }
    if (cur.isHeader) {
      const cols = cur.text.split(" | ");
      const escaped = cols.map(c => c.replace(/\*/g, "\\*"));
      tableRows.unshift("| " + escaped.join(" | ") + " |");
      tableRows.splice(1, 0, "| " + cols.map(() => "---").join(" | ") + " |");
    } else {
      tableRows.push(formatTableRow(cur.text));
    }
  }

  function flushTable() {
    if (!tableRows) return;
    parts.push(tableRows.join("\n"));
    tableRows = null;
  }

  for (let k = 0; k < selected.length; k++) {
    const cur = selected[k];
    const prev = k > 0 ? selected[k - 1] : null;
    const samePrevBlock =
      prev && prev.blockId === cur.blockId && prev.source === cur.source;

    if (cur.source === "code") {
      flushTable();
      if (samePrevBlock && codeRun) {
        codeRun.texts.push(cur.text);
      } else {
        flushCode();
        codeRun = { texts: [cur.text], lang: cur.lang };
      }
      continue;
    }

    if (cur.source === "table") {
      flushCode();
      if (samePrevBlock && tableRows) {
        appendTableRow(cur);
      } else {
        flushTable();
        startTable(cur);
      }
      continue;
    }

    flushCode();
    flushTable();

    if (samePrevBlock) {
      parts[parts.length - 1] += " " + cur.text;
    } else {
      parts.push(cur.text);
    }
  }

  flushCode();
  flushTable();
  return parts.join("\n\n");
}
