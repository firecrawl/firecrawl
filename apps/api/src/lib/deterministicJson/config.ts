import { config } from "../../config";

export const CODEGEN_MODEL = config.EXTRACT_CODEGEN_MODEL;
export const ANCHOR_MODEL = config.EXTRACT_ANCHOR_MODEL;
export const LIGHT_MODEL = config.EXTRACT_LIGHT_MODEL;
export const CODE_SANDBOX_URL = config.CODE_SANDBOX_URL;

// Bump to invalidate every cached extractor at once.
export const CACHE_VERSION = 1;

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
