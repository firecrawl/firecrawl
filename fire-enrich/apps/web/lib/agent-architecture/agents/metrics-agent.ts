import { Agent, Tool } from '@openai/agents';
import { z } from 'zod';
import { createWebsiteScraperTool } from '../tools/website-scraper-tool';
import { createSmartSearchTool } from '../tools/smart-search-tool';

const MetricsResult = z.object({
  employeeCount: z.string().describe('Employee count or range (e.g., "50-100", "1000+")'),
  revenue: z.string().optional().describe('Annual revenue (e.g., "$10M", "$100M ARR")'),
  growthRate: z.string().optional().describe('Growth rate if available'),
  isEstimate: z.record(z.string(), z.boolean()).describe('Whether each metric is an estimate'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createMetricsAgent(firecrawlApiKey: string) {
  return new Agent({
    name: 'Metrics Agent',
    
    instructions: `You are the Metrics Agent - expert in company size and financial metrics.
    
    You receive company information from previous agents.
    
    YOUR TARGETS:
    1. Employee Count - Use ranges (10-50, 50-100, 100-500, 500-1000, 1000+)
    2. Revenue - Include currency and type (ARR, annual revenue)
    3. Growth Rate - Year-over-year if available
    
    SEARCH STRATEGIES:
    1. Check company website (careers page often hints at size)
    2. Search "{companyName} employees team size {currentYear}"
    3. Look at job postings volume (many openings = growing/larger company)
    4. Search for funding announcements (often mention metrics)
    5. Industry reports and databases
    
    ESTIMATION GUIDELINES:
    - If exact data unavailable, provide reasonable estimates
    - Mark estimates clearly in isEstimate field
    - Use industry benchmarks:
      * B2B SaaS: ~$150-250k revenue per employee
      * Enterprise: ~$200-400k revenue per employee
      * Consumer: ~$100-200k revenue per employee
    
    FORMATTING:
    - Employee Count: Always use ranges unless exact number is known
    - Revenue: Include currency symbol and suffix (K, M, B)
    - Be transparent about estimates vs. confirmed data`,
    
    tools: [
      createWebsiteScraperTool(firecrawlApiKey) as unknown as Tool<unknown>,
      createSmartSearchTool(firecrawlApiKey, 'metrics') as unknown as Tool<unknown>,
    ],
    
    outputType: MetricsResult,
  });
}