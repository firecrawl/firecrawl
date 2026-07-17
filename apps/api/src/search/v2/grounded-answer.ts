import axios from "axios";
import { config } from "../../config";
import {
  SearchV2Response,
  GroundedAnswer,
  WebSearchResult,
} from "../../lib/entities";
import { Logger } from "winston";

// Synthesis LLM = the same model this pi chat uses: GLM-5.2 via the ZAI Coding
// Plan endpoint (OpenAI-compat). GLM-5.2 is a reasoning model; we read
// `content`, not `reasoning_content`.
const ZAI_CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const ZAI_MODEL = "glm-5.2";
const HHEM_VERIFY_URL =
  (config.HHEM_VERIFIER_URL ?? "http://127.0.0.1:8100") + "/verify";

const SYNTH_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 90_000;
const MAX_CONTEXT_RESULTS = 3;
const MAX_CONTEXT_CHARS = 6_000;
const SYNTH_MAX_TOKENS = 2048;

export function pickSynthesisContexts(
  results: WebSearchResult[],
  max: number,
  maxChars: number,
): string[] {
  return results
    .filter(r => typeof r.markdown === "string" && r.markdown!.length > 0)
    .slice(0, max)
    .map(r => r.markdown!.slice(0, maxChars));
}

export function buildSynthesisMessages(
  query: string,
  contexts: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "Answer the question using only the provided context. If the context does not contain the answer, say the context does not contain the answer. Keep the answer to 2-3 sentences.",
    },
    {
      role: "user",
      content: `Context:\n${contexts
        .map((c, i) => `[${i + 1}] ${c}`)
        .join("\n\n")}\n\nQuestion: ${query}`,
    },
  ];
}

async function synthesizeAnswer(
  query: string,
  contexts: string[],
): Promise<string | null> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const response = await axios.post(
      ZAI_CHAT_URL,
      {
        model: ZAI_MODEL,
        messages: buildSynthesisMessages(query, contexts),
        max_tokens: SYNTH_MAX_TOKENS,
        temperature: 0,
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
): Promise<{ faithfulness: number; grounded: boolean } | null> {
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

// Synthesize one grounded answer to the query from the top scraped pages, then
// HHEM-verify it. Best-effort: synthesis failure => no answer; verify failure
// => answer returned with grounded=false. No-op without ZAI_API_KEY or markdown.
export async function buildGroundedAnswer(
  searchResponse: SearchV2Response,
  query: string,
  logger: Logger,
): Promise<void> {
  if (!config.ZAI_API_KEY) {
    logger.warn("Grounded answer skipped: ZAI_API_KEY not set");
    return;
  }
  const contexts = pickSynthesisContexts(
    searchResponse.web ?? [],
    MAX_CONTEXT_RESULTS,
    MAX_CONTEXT_CHARS,
  );
  if (contexts.length === 0) return;

  let answer: string | null;
  try {
    answer = await synthesizeAnswer(query, contexts);
  } catch (error) {
    logger.warn("Grounded answer synthesis failed", {
      query,
      error: (error as Error)?.message,
    });
    return;
  }
  if (!answer) return;

  const grounded: GroundedAnswer = { text: answer, faithfulness: 0, grounded: false };
  try {
    const v = await verifyGrounding(answer, contexts);
    if (v) {
      grounded.faithfulness = v.faithfulness;
      grounded.grounded = v.grounded;
    }
  } catch (error) {
    logger.warn("Grounded answer verification failed (returned unverified)", {
      query,
      error: (error as Error)?.message,
    });
  }

  searchResponse.answer = grounded;
  logger.info("Grounded answer attached", {
    query,
    faithfulness: grounded.faithfulness,
    grounded: grounded.grounded,
  });
}
