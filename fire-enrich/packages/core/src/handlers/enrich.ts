import { EnrichmentStrategy } from '../strategies/enrichment-strategy.js';
import { FirecrawlService } from '../services/firecrawl.js';
import { loadSkipList, shouldSkipEmail, getSkipReason } from '../utils/skip-list.js';
import { ENRICHMENT_CONFIG } from '../config/enrichment.js';
import type { CSVRow, EnrichmentField, RowEnrichmentResult } from '../types/index.js';
import type { LLMProvider } from '../llm/provider.js';

export interface EnrichRowsOptions {
  rows: CSVRow[];
  fields: EnrichmentField[];
  emailColumn: string;
  nameColumn?: string;
  llmProvider: LLMProvider;
  firecrawlApiKey: string;
  onProgress?: (result: RowEnrichmentResult) => void;
  signal?: AbortSignal;
}

export async function enrichRows(opts: EnrichRowsOptions): Promise<RowEnrichmentResult[]> {
  const { rows, fields, emailColumn, nameColumn, llmProvider, firecrawlApiKey, onProgress, signal } = opts;

  const strategy = new EnrichmentStrategy({ firecrawlApiKey, llmProvider });
  const skipList = await loadSkipList();
  const results: RowEnrichmentResult[] = [];

  const concurrency = ENRICHMENT_CONFIG.CONCURRENT_ROWS;
  const pending: Array<() => Promise<void>> = [];

  for (let i = 0; i < rows.length; i++) {
    pending.push(async () => {
      if (signal?.aborted) return;

      const row = { ...rows[i] };
      if (nameColumn && row[nameColumn]) {
        row._name = row[nameColumn];
      }

      const email = row[emailColumn];

      if (email && shouldSkipEmail(email, skipList)) {
        const result: RowEnrichmentResult = {
          rowIndex: i,
          originalData: rows[i],
          enrichments: {},
          status: 'skipped',
          stepDetails: getSkipReason(email, skipList),
        };
        results[i] = result;
        onProgress?.(result);
        return;
      }

      const processingResult: RowEnrichmentResult = {
        rowIndex: i,
        originalData: rows[i],
        enrichments: {},
        status: 'processing',
        currentStep: 'initializing',
      };
      results[i] = processingResult;
      onProgress?.(processingResult);

      try {
        const enrichments = await strategy.enrichRow(row, fields);
        const doneResult: RowEnrichmentResult = {
          rowIndex: i,
          originalData: rows[i],
          enrichments,
          status: 'completed',
        };
        results[i] = doneResult;
        onProgress?.(doneResult);
      } catch (err) {
        const errorResult: RowEnrichmentResult = {
          rowIndex: i,
          originalData: rows[i],
          enrichments: {},
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
        results[i] = errorResult;
        onProgress?.(errorResult);
      }
    });
  }

  // Rolling concurrency
  const active: Promise<void>[] = [];
  let idx = 0;

  const runNext = async (): Promise<void> => {
    if (idx >= pending.length) return;
    const task = pending[idx++];
    await task();
    await runNext();
  };

  for (let i = 0; i < Math.min(concurrency, pending.length); i++) {
    active.push(runNext());
  }
  await Promise.all(active);

  return results;
}
