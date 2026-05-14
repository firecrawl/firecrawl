// Safe for browser bundlers — no Node.js built-ins
export * from './llm/provider.js';
export * from './llm/openai-provider.js';
export * from './types/index.js';
export * from './types/field-generation.js';
export * from './services/synthesis.js';
export * from './services/firecrawl.js';
export * from './strategies/enrichment-strategy.js';
export * from './strategies/email-parser.js';
export * from './utils/email-detection.js';
export * from './utils/field-utils.js';
export * from './utils/source-context.js';
export * from './config/enrichment.js';
export * from './handlers/generate-fields.js';
export * from './handlers/scrape.js';
export * from './handlers/search.js';

// NOTE: the following are NOT re-exported from the main barrel because they
// depend on Node.js built-ins (fs, path) and would break browser/edge bundlers:
//   utils/skip-list          → import from '@fire-enrich/core/server'
//   handlers/enrich          → import from '@fire-enrich/core/server'
//   llm/mcp-sampling-provider → import from '@fire-enrich/core/mcp'
