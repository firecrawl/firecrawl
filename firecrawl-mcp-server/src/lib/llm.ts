// src/lib/llm.ts
// OpenAI-compatible LLM client factory used by enrich_* and research tools.
//
// Defaults to OpenRouter (env-driven, see .env.example). Swap LLM_BASE_URL
// to point at OpenAI, a local Ollama, or any other compatible gateway.
//
// Per-call BYOK: every tool that uses this accepts optional llmApiKey /
// llmBaseUrl / llmModelSmart / llmModelFast args. When provided they
// override the env defaults for that single call only.

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type {
  CompleteOptions,
  CompleteResult,
  LLMProvider,
} from '@fire-enrich/core';

// @fire-enrich/core ships zod v3 schemas in its types, this MCP package
// uses zod v4. Cast at the openai/helpers/zod call site — the runtime
// shape (parse/safeParse, _def walking) is compatible across versions.
type AnyZodSchema = Parameters<typeof zodResponseFormat>[0];

export interface LLMOverrides {
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModelSmart?: string;
  llmModelFast?: string;
}

interface ResolvedLLMConfig {
  apiKey: string;
  baseURL: string | undefined;
  modelSmart: string;
  modelFast: string;
}

const DEFAULT_MODEL_SMART = 'anthropic/claude-sonnet-4-6';
const DEFAULT_MODEL_FAST = 'anthropic/claude-haiku-4-5';

function resolveConfig(overrides: LLMOverrides = {}): ResolvedLLMConfig {
  const apiKey =
    overrides.llmApiKey ??
    process.env.LLM_API_KEY ??
    process.env.OPENAI_API_KEY ??
    '';

  if (!apiKey) {
    throw new Error(
      'LLM API key missing. Set LLM_API_KEY (or OPENAI_API_KEY) in env, ' +
        'or pass `llmApiKey` as a tool argument.'
    );
  }

  // Resolve baseURL: explicit override > LLM_BASE_URL > OPENAI_BASE_URL >
  // undefined (lets the OpenAI SDK fall back to api.openai.com).
  const baseURL =
    overrides.llmBaseUrl ??
    process.env.LLM_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    undefined;

  const modelSmart =
    overrides.llmModelSmart ??
    process.env.LLM_MODEL_SMART ??
    DEFAULT_MODEL_SMART;

  const modelFast =
    overrides.llmModelFast ??
    process.env.LLM_MODEL_FAST ??
    DEFAULT_MODEL_FAST;

  return { apiKey, baseURL, modelSmart, modelFast };
}

/**
 * OpenAI-compatible LLMProvider used in place of fire-enrich/core's
 * OpenAIProvider when we need:
 *   - a custom baseURL (OpenRouter, local LLM, gateway, etc.)
 *   - configurable models per tier
 *   - per-call BYOK
 *
 * Conforms to the LLMProvider interface from @fire-enrich/core.
 */
export class OpenAICompatProvider implements LLMProvider {
  private client: OpenAI;
  private modelSmart: string;
  private modelFast: string;

  constructor(config: ResolvedLLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
    this.modelSmart = config.modelSmart;
    this.modelFast = config.modelFast;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const model = opts.tier === 'fast' ? this.modelFast : this.modelSmart;

    let responseFormat:
      | OpenAI.ResponseFormatJSONObject
      | OpenAI.ResponseFormatJSONSchema
      | undefined;
    if (opts.schema) {
      responseFormat = zodResponseFormat(
        opts.schema as unknown as AnyZodSchema,
        opts.schemaName ?? 'response'
      );
    } else if (opts.jsonMode) {
      responseFormat = { type: 'json_object' };
    }

    const response = await this.client.chat.completions.create({
      model,
      messages: opts.messages,
      stream: false,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
      ...(responseFormat && { response_format: responseFormat }),
    });
    const text = response.choices[0]?.message?.content ?? '';

    let parsed: unknown = undefined;
    if ((opts.schema || opts.jsonMode) && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // caller decides whether to fall back to raw text
      }
    }

    return { text, parsed };
  }
}

/**
 * Build an LLM provider from env + per-call overrides. Throws if no
 * API key is reachable.
 */
export function createLLMProvider(
  overrides: LLMOverrides = {}
): OpenAICompatProvider {
  return new OpenAICompatProvider(resolveConfig(overrides));
}

/**
 * Zod-friendly description block — copy-paste this into tool parameters
 * so every meta-tool advertises BYOK identically.
 */
export const LLM_OVERRIDE_FIELDS = {
  llmApiKey:
    'Optional LLM API key (OpenRouter, OpenAI, etc.). Falls back to LLM_API_KEY env.',
  llmBaseUrl:
    'Optional LLM base URL (e.g. https://openrouter.ai/api/v1). Falls back to LLM_BASE_URL env.',
  llmModelSmart:
    'Optional model id for high-quality reasoning steps (synthesis). Falls back to LLM_MODEL_SMART env.',
  llmModelFast:
    'Optional model id for quick classification steps. Falls back to LLM_MODEL_FAST env.',
} as const;
