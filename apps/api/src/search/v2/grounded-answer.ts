import axios from "axios";
import { config } from "../../config";
import {
  SearchV2Response,
  GroundedAnswer,
  WebSearchResult,
} from "../../lib/entities";
import { Logger } from "winston";
import { persistVerifiedChunks, cacheAnswer } from "./persistence";

// Synthesis LLM = the same model this pi chat uses: GLM-5.2 via the ZAI Coding
// Plan endpoint (OpenAI-compat). thinking:{type:"disabled"} + temperature:0
// mirror the pi fetch-no-thinking extension (direct verdicts, no reasoning).
const ZAI_CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const ZAI_MODEL = "glm-5.2";
const HHEM_VERIFY_URL =
  (config.HHEM_VERIFIER_URL ?? "http://127.0.0.1:8100") + "/verify";

const SYNTH_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 300_000;
const SUFFICIENCY_TIMEOUT_MS = 30_000;
const SYNTH_MAX_TOKENS = 2048;

// Policy thresholds. The HHEM service sets grounded = faithfulness >= 0.7; below
// REGEN_FLOOR the answer is too weak to salvage, so abstain without regenerating.
const REGEN_FLOOR = 0.3;
const ABSTAIN_TEXT =
  "I am not confident in the accuracy of this information based on the retrieved context.";

const SYNTHESIS_SYSTEM =
  "Answer the question using only the provided context. If the context does not contain the answer, say the context does not contain the answer. Keep the answer to 2-3 sentences. Cite every factual claim with [N] where N is the source number shown in the context (e.g. [1], [2]).";
const SYNTHESIS_SYSTEM_STRICT =
  "Your previous answer contained claims not supported by the context. Answer the question using ONLY the provided context. Ensure EVERY claim is directly supported by the context and cite it with [N]. If the context does not support an answer, say the context does not contain the answer. Keep it to 2-3 sentences.";

export interface SynthesisSource {
  n: number;
  url: string;
  title: string;
  text: string;
}

// Gather every scraped page that yielded RAG passages as an answer source.
// No count cap, no head-truncate: each source's text is its full set of
// query-relevant passages (the chunks RAG already selected), so synth and
// HHEM both read the relevant parts of the whole page, not a truncated head.
// `n` follows the markdown-result order used by attachRagPassages so the
// answer's [N] citations line up with each passage's `source` tag.
export function gatherAnswerSources(
  results: WebSearchResult[],
): SynthesisSource[] {
  const out: SynthesisSource[] = [];
  let n = 0;
  for (const r of results) {
    if (typeof r.markdown !== "string" || r.markdown.length === 0) continue;
    n += 1;
    const passages = Array.isArray(r.passages) ? r.passages : [];
    if (passages.length === 0) continue;
    out.push({
      n,
      url: r.url,
      title: r.title,
      text: passages.map(p => p.text).join("\n\n"),
    });
  }
  return out;
}

// Parse [N] citation markers from the synthesized answer (handles [1] and
// grouped [1, 2, 3]); keep only N in the valid source range.
export function extractCitations(text: string, maxN: number): number[] {
  const ns = new Set<number>();
  for (const m of text.matchAll(/\[([\d,\s]+)\]/g)) {
    for (const part of m[1].split(",")) {
      const n = parseInt(part.trim(), 10);
      if (n >= 1 && n <= maxN) ns.add(n);
    }
  }
  return [...ns].sort((a, b) => a - b);
}

// Post-generation policy on HHEM faithfulness. `grounded` already encodes the
// accept threshold (>=0.7); below the floor there is nothing to salvage.
export function decidePolicy(
  faithfulness: number,
  grounded: boolean,
  regenFloor: number,
): "accept" | "regen" | "abstain" {
  if (grounded) return "accept";
  if (faithfulness < regenFloor) return "abstain";
  return "regen";
}

export function buildSnippets(results: WebSearchResult[]): string[] {
  return results.map(r =>
    `${r.title}${r.description ? ` — ${r.description}` : ""}`,
  );
}

const SUFFICIENCY_SYSTEM =
  "You are a strict retrieval evaluator. Given a query and search-result snippets, decide if the snippets CLEARLY contain enough information to answer the query. Answer with ONLY 'YES' or 'NO'. When in doubt, answer 'YES' — say 'NO' only if the snippets plainly cannot answer.";

// Pre-scrape sufficiency gate: judge from search snippets whether retrieval is
// worth scraping at all. Strict (biases toward YES) so borderline queries fall
// through to scrape, where the HHEM grounding gate catches real insufficiency.
// Returns true = sufficient (proceed); false = refuse (skip the scrape tail).
export async function checkSufficiency(
  query: string,
  snippets: string[],
  logger: Logger,
): Promise<boolean> {
  if (!config.ZAI_API_KEY) {
    logger.warn("Sufficiency gate skipped: ZAI_API_KEY not set");
    return true;
  }
  if (snippets.length === 0) return false;

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), SUFFICIENCY_TIMEOUT_MS);
  try {
    const response = await axios.post(
      ZAI_CHAT_URL,
      {
        model: ZAI_MODEL,
        messages: [
          { role: "system", content: SUFFICIENCY_SYSTEM },
          {
            role: "user",
            content: `Query: ${query}\n\nSnippets:\n${snippets
              .map((s, i) => `[${i + 1}] ${s}`)
              .join("\n")}`,
          },
        ],
        max_tokens: 16,
        temperature: 0,
        thinking: { type: "disabled" },
      },
      {
        headers: {
          Authorization: `Bearer ${config.ZAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );
    const content: string =
      response.data?.choices?.[0]?.message?.content ?? "";
    const upper = content.trim().toUpperCase();
    // Fail-open: refuse only on an explicit NO. An empty/odd response must not
    // false-refuse a good query -- the HHEM grounding gate backstops it.
    const explicitNo = upper.startsWith("N");
    if (!upper.startsWith("Y") && !explicitNo) {
      logger.warn("Sufficiency gate returned ambiguous verdict; proceeding", {
        query,
        raw: content,
      });
    }
    const sufficient = !explicitNo;
    logger.info("Sufficiency gate", { query, verdict: sufficient, raw: content });
    return sufficient;
  } catch (error) {
    logger.warn("Sufficiency gate failed; proceeding (fail-open)", {
      query,
      error: (error as Error)?.message,
    });
    return true;
  } finally {
    clearTimeout(handle);
  }
}

export function buildSynthesisMessages(
  query: string,
  sources: SynthesisSource[],
  strict = false,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: strict ? SYNTHESIS_SYSTEM_STRICT : SYNTHESIS_SYSTEM,
    },
    {
      role: "user",
      content: `Context:\n${sources
        .map(s => `[${s.n}] ${s.text}`)
        .join("\n\n")}\n\nQuestion: ${query}`,
    },
  ];
}

async function synthesizeAnswer(
  query: string,
  sources: SynthesisSource[],
  strict = false,
): Promise<string | null> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const response = await axios.post(
      ZAI_CHAT_URL,
      {
        model: ZAI_MODEL,
        messages: buildSynthesisMessages(query, sources, strict),
        max_tokens: SYNTH_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
      },
      {
        headers: {
          Authorization: `Bearer ${config.ZAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim().length > 0
      ? content.trim()
      : null;
  } finally {
    clearTimeout(handle);
  }
}

async function verifyGrounding(
  answer: string,
  contexts: string[],
): Promise<{ faithfulness: number; grounded: boolean }> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await axios.post(
      HHEM_VERIFY_URL,
      { answer, contexts },
      {
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      },
    );
    const f = response.data?.faithfulness;
    return {
      faithfulness: typeof f === "number" ? f : 0,
      grounded: response.data?.grounded === true,
    };
  } finally {
    clearTimeout(handle);
  }
}

async function tryVerify(
  answer: string,
  contexts: string[],
  query: string,
  logger: Logger,
): Promise<{ faithfulness: number; grounded: boolean } | null> {
  try {
    return await verifyGrounding(answer, contexts);
  } catch (error) {
    logger.warn("HHEM verify failed; treating as unverified", {
      query,
      error: (error as Error)?.message,
    });
    return null;
  }
}

// Synthesize one grounded answer, HHEM-verify it, and apply the accept /
// regenerate / abstain policy. Accept => keep the cited answer; regen => one
// stricter retry; abstain (or below the floor) => canned text + low_confidence.
// No-op without ZAI_API_KEY or scraped markdown.
export async function buildGroundedAnswer(
  searchResponse: SearchV2Response,
  query: string,
  logger: Logger,
): Promise<void> {
  if (!config.ZAI_API_KEY) {
    logger.warn("Grounded answer skipped: ZAI_API_KEY not set");
    return;
  }
  const sources = gatherAnswerSources(searchResponse.web ?? [])
  if (sources.length === 0) return;
  const contexts = sources.map(s => s.text);
  const sourceList = sources.map(s => ({ n: s.n, url: s.url, title: s.title }));

  let first;
  try {
    const __tSynth = Date.now();
    const answer = await synthesizeAnswer(query, sources, false);
    if (!answer) return;
    const __tVerify = Date.now();
    const __v = await tryVerify(answer, contexts, query, logger);
    logger.info(`ga.timing synth ${Date.now() - __tSynth}ms`);
    logger.info(`ga.timing verify ${Date.now() - __tVerify}ms contexts_chars=${contexts.reduce((a, c) => a + c.length, 0)}`);
    first = { answer, v: __v };
  } catch (error) {
    logger.warn("Grounded answer synthesis failed", {
      query,
      error: (error as Error)?.message,
    });
    return;
  }

  let text = first.answer as string;
  let v = first.v as {
    faithfulness: number;
    grounded: boolean;
  } | null;
  let abstain = false;

  if (v) {
    const policy = decidePolicy(v.faithfulness, v.grounded, REGEN_FLOOR);
    if (policy === "regen") {
      logger.info("Grounded answer not grounded; regenerating", {
        query,
        faithfulness: v.faithfulness,
      });
      try {
        const regen = await synthesizeAnswer(query, sources, true);
        if (regen) {
          const v2 = await tryVerify(regen, contexts, query, logger);
          if (v2?.grounded) {
            text = regen;
            v = v2;
          } else {
            abstain = true;
          }
        } else {
          abstain = true;
        }
      } catch (error) {
        logger.warn("Grounded answer regeneration failed; abstaining", {
          query,
          error: (error as Error)?.message,
        });
        abstain = true;
      }
    } else if (policy === "abstain") {
      abstain = true;
    }
  }

  const cited = extractCitations(text, sources.length);
  logger.info("Grounded answer citations", { query, cited });

  const grounded: GroundedAnswer = {
    text: abstain ? ABSTAIN_TEXT : text,
    faithfulness: v?.faithfulness ?? 0,
    grounded: abstain ? false : (v?.grounded ?? false),
    sources: sourceList,
    ...(abstain ? { reason: "low_confidence" as const } : {}),
  };
  searchResponse.answer = grounded;
  logger.info("Grounded answer attached", {
    query,
    faithfulness: grounded.faithfulness,
    grounded: grounded.grounded,
    abstain,
  });

  // Persist the verified source passages to pgvector for later semantic
  // retrieval (cache). Only on accept -- abstained/insufficient answers are
  // never stored. Best-effort (see persistence.ts).
  if (grounded.grounded) {
    const items: Array<{ url: string; text: string }> = [];
    for (const s of sources) {
      const r = (searchResponse.web ?? []).find(r => r.url === s.url);
      for (const p of r?.passages ?? []) {
        items.push({ url: s.url, text: p.text });
      }
    }
    const __tPC = Date.now();
    await Promise.all([
      persistVerifiedChunks(items, grounded.faithfulness, logger),
      cacheAnswer(query, grounded.text, grounded.faithfulness, sourceList, logger),
    ]);
    logger.info(`ga.timing persist+cache ${Date.now() - __tPC}ms (parallel)`);
    await cacheAnswer(query, grounded.text, grounded.faithfulness, sourceList, logger);
  }
}
