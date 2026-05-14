import { AgentOrchestrator } from './orchestrator';

export { AgentOrchestrator } from './orchestrator';
export * from './core/types';

// Factory function for easy initialization
export function createAgentOrchestrator(
  firecrawlApiKey: string,
  openaiApiKey: string
) {
  return new AgentOrchestrator(firecrawlApiKey, openaiApiKey);
}