// src/custom-tools/fire-enrich-email.ts
// Custom tool: fire_enrich_email
// LLM-powered single-email enrichment using @fire-enrich/core's multi-agent
// strategy. For each requested field the strategy plans a search, scrapes
// candidate sources, and synthesises an answer with citations.
//
// Distinct from the heuristic firecrawl_enrich tool — that one returns a
// fixed company profile via search→scrape regex. fire_enrich_email is
// driven by the user's `fields` array and uses an LLM at every step.

import { z } from 'zod';
import {
  EnrichmentStrategy,
  type EnrichmentField,
} from '@fire-enrich/core';

import type { MCP, SessionData } from './types.js';
import { createLLMProvider, LLM_OVERRIDE_FIELDS } from '../lib/llm.js';

const EnrichmentFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Snake-case field key (e.g. "company_name")'),
  displayName: z.string().min(1).describe('Human-readable label'),
  description: z
    .string()
    .min(1)
    .describe('What to extract — the LLM uses this to plan its searches'),
  type: z.enum(['string', 'number', 'boolean', 'array']),
  required: z.boolean(),
});

export function register(server: MCP): void {
  server.addTool({
    name: 'fire_enrich_email',
    description: `
LLM-powered enrichment for a single email address.

For each requested field the multi-agent strategy: (1) plans a search query,
(2) calls Firecrawl search/scrape to gather sources, (3) synthesises an answer
with source attribution.

**Best for:** "given this email, what is X / Y / Z about the company / person?"
when you can describe the fields you want.
**Not for:** bulk CSV runs (use fire_enrich_rows). Pre-baked company profile
(use the simpler firecrawl_enrich).

**Usage Example:**
\`\`\`json
{
  "name": "fire_enrich_email",
  "arguments": {
    "email": "ericciarla@firecrawl.dev",
    "fields": [
      { "name": "company_name", "displayName": "Company", "description": "Company that owns this email domain", "type": "string", "required": true },
      { "name": "industry", "displayName": "Industry", "description": "Primary industry vertical", "type": "string", "required": false }
    ]
  }
}
\`\`\`

**BYOK:** pass \`firecrawlApiKey\` / \`llmApiKey\` / \`llmBaseUrl\` to override
the server defaults for this single call.

**Returns:** \`{ email, enrichments: { <fieldName>: { value, confidence, source } } }\`
`,
    parameters: z.object({
      email: z
        .string()
        .email()
        .describe('Email address to enrich (e.g. eric@firecrawl.dev)'),
      fields: z
        .array(EnrichmentFieldSchema)
        .min(1)
        .describe('Fields to extract — at least one required'),
      name: z
        .string()
        .optional()
        .describe('Known person name, used to bias people-search queries'),
      firecrawlApiKey: z
        .string()
        .optional()
        .describe(
          'Override Firecrawl API key for this call. Falls back to FIRECRAWL_API_KEY env / session.'
        ),
      llmApiKey: z.string().optional().describe(LLM_OVERRIDE_FIELDS.llmApiKey),
      llmBaseUrl: z
        .string()
        .optional()
        .describe(LLM_OVERRIDE_FIELDS.llmBaseUrl),
      llmModelSmart: z
        .string()
        .optional()
        .describe(LLM_OVERRIDE_FIELDS.llmModelSmart),
      llmModelFast: z
        .string()
        .optional()
        .describe(LLM_OVERRIDE_FIELDS.llmModelFast),
    }),
    execute: async (args, context) => {
      const { session } = context as { session?: SessionData };
      const params = args as {
        email: string;
        fields: EnrichmentField[];
        name?: string;
        firecrawlApiKey?: string;
        llmApiKey?: string;
        llmBaseUrl?: string;
        llmModelSmart?: string;
        llmModelFast?: string;
      };

      const firecrawlApiKey =
        params.firecrawlApiKey ??
        session?.firecrawlApiKey ??
        process.env.FIRECRAWL_API_KEY ??
        '';

      if (!firecrawlApiKey) {
        return JSON.stringify(
          {
            error:
              'No Firecrawl API key. Set FIRECRAWL_API_KEY env, pass firecrawlApiKey, or supply via session.',
          },
          null,
          2
        );
      }

      let llmProvider;
      try {
        llmProvider = createLLMProvider({
          llmApiKey: params.llmApiKey,
          llmBaseUrl: params.llmBaseUrl,
          llmModelSmart: params.llmModelSmart,
          llmModelFast: params.llmModelFast,
        });
      } catch (err) {
        return JSON.stringify(
          { error: err instanceof Error ? err.message : String(err) },
          null,
          2
        );
      }

      const strategy = new EnrichmentStrategy({
        firecrawlApiKey,
        llmProvider,
      });

      const row: Record<string, string> = { email: params.email };
      if (params.name) row._name = params.name;

      try {
        const enrichments = await strategy.enrichRow(row, params.fields);
        return JSON.stringify(
          { email: params.email, enrichments },
          null,
          2
        );
      } catch (err) {
        return JSON.stringify(
          {
            email: params.email,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2
        );
      }
    },
  });
}
