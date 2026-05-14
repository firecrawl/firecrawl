import type { ZodSchema } from 'zod';

export type LLMTier = 'fast' | 'smart';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  messages: Message[];
  schema?: ZodSchema;
  schemaName?: string;
  jsonMode?: boolean;
  tier?: LLMTier;
  temperature?: number;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  parsed?: unknown;
}

export interface LLMProvider {
  complete(opts: CompleteOptions): Promise<CompleteResult>;
}
