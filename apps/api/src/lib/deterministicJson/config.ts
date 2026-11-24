import { z } from "zod";
import { defineEnv } from "../../service/env";

const deterministicJsonEnv = defineEnv(
  "deterministic-json",
  z.object({
    EXTRACT_CODEGEN_MODEL: z.string().default("gemini-3.1-flash-lite"),
    EXTRACT_ANCHOR_MODEL: z.string().default("openai/gpt-oss-120b"),
    EXTRACT_LIGHT_MODEL: z.string().default("openai/gpt-oss-20b"),
    CODE_SANDBOX_URL: z.string().default("ws://code-sandbox:3001"),
  }),
);

export const CODEGEN_MODEL = deterministicJsonEnv.EXTRACT_CODEGEN_MODEL;
export const ANCHOR_MODEL = deterministicJsonEnv.EXTRACT_ANCHOR_MODEL;
export const LIGHT_MODEL = deterministicJsonEnv.EXTRACT_LIGHT_MODEL;
export const CODE_SANDBOX_URL = deterministicJsonEnv.CODE_SANDBOX_URL;

// Bump to invalidate every cached extractor at once.
export const CACHE_VERSION = 2;

export const MARKDOWN_BUDGET = 50_000;
export const HTML_BUDGET = 40_000;

export const ANCHOR_PER_BLOCK_BUDGET = 8_000;
export const ANCHOR_TOTAL_BUDGET = 60_000;
export const ANCHOR_MAX_BLOCKS = 16;
export const ANCHOR_MAX_PARENTS = 8;

export const CODEGEN_MAX_TOKENS = 16_384;
export const ANCHOR_PICKER_MAX_TOKENS = 2_000;
export const ASK_LLM_MAX_TOKENS = 2_048;

export const ASK_LLM_MAX_CALLS = 50;

export const SANDBOX_TIMEOUT_MS = 120_000;
