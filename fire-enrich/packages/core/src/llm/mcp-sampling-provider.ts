import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { LLMProvider, CompleteOptions, CompleteResult } from './provider.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const INTELLIGENCE_PRIORITY = { smart: 1, fast: 0 } as const;

export class MCPSamplingProvider implements LLMProvider {
  constructor(private server: Server) {}

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const tier = opts.tier ?? 'smart';
    const maxTokens = opts.maxTokens ?? (tier === 'fast' ? 1000 : 4096);

    const messages = opts.messages.filter(m => m.role !== 'system');
    const systemParts: string[] = [];

    const systemMsg = opts.messages.find(m => m.role === 'system');
    if (systemMsg) systemParts.push(systemMsg.content);

    if (opts.schema) {
      const jsonSchema = zodToJsonSchema(opts.schema, { name: opts.schemaName ?? 'response' });
      systemParts.push(
        `You MUST respond with ONLY valid JSON that matches this schema. No prose, no markdown fences.\n\nSchema:\n${JSON.stringify(jsonSchema, null, 2)}`
      );
    } else if (opts.jsonMode) {
      systemParts.push('You MUST respond with ONLY valid JSON. No prose, no markdown fences.');
    }

    const systemPrompt = systemParts.join('\n\n') || undefined;

    const samplingMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: { type: 'text' as const, text: m.content },
    }));

    const text = await this.callWithRetry(samplingMessages, systemPrompt, maxTokens, tier, opts);
    let parsed: unknown = undefined;

    if (opts.schema || opts.jsonMode) {
      try {
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // parsed stays undefined; caller handles
      }
    }

    return { text, parsed };
  }

  private async callWithRetry(
    messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>,
    systemPrompt: string | undefined,
    maxTokens: number,
    tier: 'smart' | 'fast',
    opts: CompleteOptions,
    attempt = 0
  ): Promise<string> {
    const result = await this.server.createMessage({
      messages,
      maxTokens,
      ...(systemPrompt && { systemPrompt }),
      modelPreferences: { intelligencePriority: INTELLIGENCE_PRIORITY[tier] },
    });

    const text = result.content.type === 'text' ? result.content.text : '';

    if ((opts.schema || opts.jsonMode) && attempt === 0) {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      try {
        JSON.parse(cleaned);
        return text;
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        const retryMessages = [
          ...messages,
          { role: 'assistant' as const, content: { type: 'text' as const, text } },
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Your previous response was not valid JSON. Parse error: ${errorMsg}\n\nPlease respond again with ONLY valid JSON matching the schema.`,
            },
          },
        ];
        return this.callWithRetry(retryMessages, systemPrompt, maxTokens, tier, opts, 1);
      }
    }

    return text;
  }
}
