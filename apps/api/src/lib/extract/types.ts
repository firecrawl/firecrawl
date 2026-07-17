import { TokenUsage, URLTrace } from "../../controllers/v2/types";

export interface ExtractResult {
  success: boolean;
  data?: any;
  extractId: string;
  warning?: string;
  urlTrace?: URLTrace[];
  error?: string;
  tokenUsageBreakdown?: TokenUsage[];
  llmUsage?: number;
  totalUrlsScraped?: number;
  sources?: Record<string, string[]>;
  tokensBilled?: number;
  creditsBilled?: number;
}
