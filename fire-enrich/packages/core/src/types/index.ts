export interface CSVRow {
  [key: string]: string;
}

export interface EnrichmentField {
  name: string;
  displayName: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  required: boolean;
}

export interface EnrichmentRequest {
  rows: CSVRow[];
  fields: EnrichmentField[];
  emailColumn: string;
  nameColumn?: string;
  useAgents?: boolean;
  useV2Architecture?: boolean;
}

export interface SearchResult {
  url: string;
  title: string;
  description: string;
  markdown?: string;
  html?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    keywords?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
    author?: string;
    publishedDate?: string;
    [key: string]: string | undefined;
  };
}

export interface EnrichmentResult {
  field: string;
  value: string | number | boolean | string[];
  confidence: number;
  source?: string;
  sourceContext?: {
    url: string;
    snippet: string;
  }[];
  sourceCount?: number;
  corroboration?: {
    evidence: Array<{
      value: string | number | boolean | string[];
      source_url: string;
      exact_text: string;
      confidence: number;
    }>;
    sources_agree: boolean;
  };
}

export interface RowEnrichmentResult {
  rowIndex: number;
  originalData: CSVRow;
  enrichments: Record<string, EnrichmentResult>;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'skipped';
  currentStep?: 'initializing' | 'searching' | 'scraping' | 'extracting' | 'finalizing';
  stepDetails?: string;
  error?: string;
}

export interface EnrichmentSession {
  id: string;
  totalRows: number;
  processedRows: number;
  results: RowEnrichmentResult[];
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  startedAt: Date;
}