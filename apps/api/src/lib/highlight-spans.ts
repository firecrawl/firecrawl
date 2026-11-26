import {
  parseMarkdownToSentences as nativeParseMarkdownToSentences,
  assembleAnswer as nativeAssembleAnswer,
} from "@mendable/firecrawl-rs";

// Shared candidate-span generation and structure-aware reassembly for the
// query-highlights models. Both the scrape `highlights` format and the search
// highlights beta must generate candidates here and reassemble selected
// indices with `assembleAnswer` so span boundaries match model training.

type SentenceSource = "heading" | "text" | "code" | "table";

interface Sentence {
  text: string;
  source: SentenceSource;
  blockId: number;
  lang?: string;
  isHeader?: boolean;
}

/**
 * Split markdown into the line-like candidate spans the highlight models were
 * trained on. Each span carries its source kind (heading/text/code/table),
 * a blockId grouping spans from the same source block, and table/code metadata
 * so `assembleAnswer` can reconstruct structure from the selected spans.
 */
export function parseMarkdownToSentences(markdown: string): Sentence[] {
  return nativeParseMarkdownToSentences(markdown) as Sentence[];
}

/**
 * Reassemble the spans the model selected (by index into the
 * `parseMarkdownToSentences` output) back into readable markdown.
 * Structure-aware: a selected table row pulls in its header and rebuilds the
 * table syntax; consecutive code spans rebuild a fenced block; same-block text
 * spans rejoin into a paragraph.
 */
export function assembleAnswer(
  sentences: Sentence[],
  indices: number[],
): string {
  const validIndices = indices.filter(
    i => Number.isInteger(i) && i >= 0 && i < sentences.length,
  );
  return nativeAssembleAnswer(sentences, validIndices);
}
