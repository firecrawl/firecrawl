import { z } from 'zod';

// Email context that flows through all agents
export const EmailContext = z.object({
  email: z.string().email(),
  domain: z.string(),
  companyDomain: z.string().optional(),
  personalName: z.string().optional(),
  companyNameGuess: z.string().optional(),
  isPersonalEmail: z.boolean(),
});

export type EmailContext = z.infer<typeof EmailContext>;

// Enrichment field definition
export const EnrichmentFieldSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array']),
  required: z.boolean().default(false),
});

export type EnrichmentField = z.infer<typeof EnrichmentFieldSchema>;

// Handoff data between agents
export const EnrichmentHandoff = z.object({
  email: z.string().email(),
  emailContext: EmailContext,
  requestedFields: z.array(EnrichmentFieldSchema),
  discoveredData: z.record(z.string(), z.any()).optional(),
  currentAgent: z.string().optional(),
  processedFields: z.array(z.string()).optional(),
});

export type EnrichmentHandoff = z.infer<typeof EnrichmentHandoff>;

// Result from each agent
export const AgentResult = z.object({
  fields: z.record(z.string(), z.any()),
  confidence: z.record(z.string(), z.number()),
  sources: z.record(z.string(), z.array(z.string())),
  errors: z.record(z.string(), z.string()).optional(),
});

export type AgentResult = z.infer<typeof AgentResult>;

// Final enrichment result
export interface EnrichmentResult {
  field: string;
  value: string | number | boolean | string[] | null;
  confidence: number;
  source?: string;
  sourceContext?: Array<{
    url: string;
    snippet: string;
  }>;
}

export interface RowEnrichmentResult {
  rowIndex: number;
  originalData: Record<string, string>;
  enrichments: Record<string, EnrichmentResult>;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'skipped';
  error?: string;
}