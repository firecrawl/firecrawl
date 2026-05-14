import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { LLMProvider, CompleteOptions, CompleteResult } from './provider.js';

const MODEL_MAP = {
  smart: 'gpt-5',
  fast: 'gpt-5-mini',
} as const;

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const model = MODEL_MAP[opts.tier ?? 'smart'];

    let responseFormat: OpenAI.ResponseFormatJSONObject | OpenAI.ResponseFormatJSONSchema | undefined;
    if (opts.schema) {
      responseFormat = zodResponseFormat(opts.schema, opts.schemaName ?? 'response');
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
    const text = response.choices[0].message.content ?? '';

    let parsed: unknown = undefined;
    if ((opts.schema || opts.jsonMode) && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // caller handles raw text fallback
      }
    }

    return { text, parsed };
  }
}
