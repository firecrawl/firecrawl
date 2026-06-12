import type { Logger } from "winston";
import { config } from "../config";

// Semantic highlight model: it scores each sentence of a context against a
// question (semantic similarity), no LLM. Inference is fast (~10ms), but the
// model caps context at ~4k tokens, so we chunk the page, score every chunk,
// pool the per-sentence scores globally, and keep the best sentences. Endpoint
// is config-gated (HIGHLIGHT_MODEL_URL); callers must confirm it's set via
// highlightsEnvReady() before invoking.

// ~4 chars/token; 10k chars (~2.5k tokens) leaves headroom under the 4k cap for
// the question + tokenizer variance (markdown/code tokenizes denser than prose).
const CHUNK_CHARS = 10000;
// Bound load for very long pages (chunks run concurrently per result).
const MAX_CHUNKS = 10;
// Keep sentences scoring at/above this (matches the model's default threshold).
const SELECT_THRESHOLD = 0.5;
// Cap the assembled snippet length.
const MAX_SELECTED = 12;
const REQUEST_TIMEOUT_MS = 30000;

interface ScoredSentence {
  text: string;
  score: number;
  order: number; // global document order
}

// Strip markdown syntax so a highlight reads as plain prose: links/images keep
// their text, bare URLs and emphasis/heading/code marks go, line-number gutters
// from rendered code blocks are dropped, whitespace collapses.
function cleanSentence(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/https?:\/\/\S+/g, " ") // bare URLs
    .replace(/^\s*\d+\s*/, "") // leading code-block line number
    .replace(/[#*`>_~|\\]+/g, " ") // markdown marks
    .replace(/\s+/g, " ")
    .trim();
}

// Drop markdown/code artifacts (line numbers, "=====", "//", "[ 01 / 06 ]")
// that the semantic model sometimes scores highly. Real sentences have prose.
function isContentful(text: string): boolean {
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length;
  return letters >= 15;
}

interface HighlightModelResponse {
  kept_sentences?: string[];
  sentence_probabilities?: number[];
}

/**
 * Split markdown into chunks under the model's token budget. Splits on blank
 * lines (paragraph boundaries) to avoid cutting mid-sentence; oversized
 * paragraphs are hard-split as a last resort. Capped at MAX_CHUNKS.
 */
function chunkMarkdown(markdown: string): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim() !== "") chunks.push(current);
    current = "";
  };

  for (const para of markdown.split(/\n{2,}/)) {
    if (chunks.length >= MAX_CHUNKS) break;

    if (para.length > CHUNK_CHARS) {
      flush();
      for (
        let i = 0;
        i < para.length && chunks.length < MAX_CHUNKS;
        i += CHUNK_CHARS
      ) {
        chunks.push(para.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }

    if (current.length + para.length + 2 > CHUNK_CHARS) {
      flush();
    }
    current += (current === "" ? "" : "\n\n") + para;
  }

  if (chunks.length < MAX_CHUNKS) flush();
  return chunks.slice(0, MAX_CHUNKS);
}

async function scoreChunk(
  question: string,
  context: string,
  logger: Logger,
): Promise<{ text: string; score: number }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.HIGHLIGHT_MODEL_URL}/v1/highlight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        context,
        // threshold 0 => every sentence is returned with its score, so we can
        // pool scores across chunks and select globally.
        threshold: 0.0,
        language: "auto",
        return_sentence_metrics: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `highlight model HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as HighlightModelResponse;
    const sentences = data.kept_sentences ?? [];
    const probs = data.sentence_probabilities ?? [];
    const n = Math.min(sentences.length, probs.length);
    const out: { text: string; score: number }[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ text: sentences[i], score: probs[i] });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate query-relevant highlights from page markdown using the semantic
 * highlight model. Returns the assembled highlight string (best sentences in
 * document order), or null if nothing clears the threshold / all chunks fail.
 */
export async function generateSemanticHighlights(
  markdown: string,
  query: string,
  opts: { logger: Logger },
): Promise<string | null> {
  const chunks = chunkMarkdown(markdown);
  if (chunks.length === 0) return null;

  const start = Date.now();
  const perChunk = await Promise.all(
    chunks.map(async (chunk, idx) => {
      try {
        return await scoreChunk(query, chunk, opts.logger);
      } catch (error) {
        opts.logger.warn("highlight model chunk failed", {
          error: error instanceof Error ? error.message : String(error),
          chunkIdx: idx,
        });
        return [];
      }
    }),
  );

  // Pool every scored sentence, preserving document order (Promise.all keeps
  // chunk order, and sentences within a chunk are already in order).
  const all: ScoredSentence[] = [];
  let order = 0;
  for (const chunkSentences of perChunk) {
    for (const s of chunkSentences) {
      const idx = order++;
      const cleaned = cleanSentence(s.text);
      if (isContentful(cleaned)) {
        all.push({ text: cleaned, score: s.score, order: idx });
      }
    }
  }
  if (all.length === 0) return null;

  // Pick the best: keep sentences at/above the threshold, cap to the top
  // MAX_SELECTED by score, then restore document order for readability.
  let selected = all.filter(s => s.score >= SELECT_THRESHOLD);
  if (selected.length === 0) return null;
  selected.sort((a, b) => b.score - a.score);
  selected = selected.slice(0, MAX_SELECTED);
  selected.sort((a, b) => a.order - b.order);

  const text = selected
    .map(s => s.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  opts.logger.info("semantic highlights generated", {
    chunks: chunks.length,
    scoredSentences: all.length,
    selected: selected.length,
    topScore: all.reduce((m, s) => Math.max(m, s.score), 0),
    elapsedMs: Date.now() - start,
  });

  return text === "" ? null : text;
}
