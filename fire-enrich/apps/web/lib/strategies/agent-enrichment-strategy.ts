import { AgentOrchestrator } from '../agent-architecture';
import type { CSVRow, EnrichmentField, RowEnrichmentResult, EnrichmentResult } from '../types';
import { shouldSkipEmail, loadSkipList, getSkipReason } from '../utils/skip-list';

export class AgentEnrichmentStrategy {
  private orchestrator: AgentOrchestrator;
  
  constructor(
    openaiApiKey: string,
    firecrawlApiKey: string,
  ) {
    this.orchestrator = new AgentOrchestrator(firecrawlApiKey, openaiApiKey);
  }
  
  async enrichRow(
    row: CSVRow,
    fields: EnrichmentField[],
    emailColumn: string,
    onProgress?: (field: string, value: unknown) => void,
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<RowEnrichmentResult> {
    const email = row[emailColumn];
    console.log(`[AgentEnrichmentStrategy] Starting enrichment for email: ${email}`);
    console.log(`[AgentEnrichmentStrategy] Requested fields: ${fields.map(f => f.name).join(', ')}`);
    
    if (!email) {
      console.log(`[AgentEnrichmentStrategy] No email found in column: ${emailColumn}`);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: 'No email found in specified column',
      };
    }
    
    // Check skip list
    const skipList = await loadSkipList();
    if (shouldSkipEmail(email, skipList)) {
      const skipReason = getSkipReason(email, skipList);
      console.log(`[AgentEnrichmentStrategy] Skipping email ${email}: ${skipReason}`);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'skipped',
        error: skipReason,
      };
    }
    
    try {
      console.log(`[AgentEnrichmentStrategy] Delegating to AgentOrchestrator`);
      // Use the agent orchestrator for enrichment
      const result = await this.orchestrator.enrichRow(
        row,
        fields,
        emailColumn,
        onProgress,
        onAgentProgress
      );
      
      // Filter out null values to match the expected type
      const filteredEnrichments: Record<string, EnrichmentResult> = {};
      for (const [key, enrichment] of Object.entries(result.enrichments)) {
        if (enrichment.value !== null) {
          filteredEnrichments[key] = enrichment as EnrichmentResult;
        }
      }
      
      const enrichedCount = Object.keys(filteredEnrichments).length;
      console.log(`[AgentEnrichmentStrategy] Orchestrator returned ${enrichedCount} enriched fields`);
      
      return {
        ...result,
        enrichments: filteredEnrichments
      };
    } catch (error) {
      console.error('[AgentEnrichmentStrategy] Enrichment error:', error);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}