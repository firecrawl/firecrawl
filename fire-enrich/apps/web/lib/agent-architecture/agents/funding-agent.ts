import { Agent, Tool } from '@openai/agents';
import { z } from 'zod';
import { createSmartSearchTool } from '../tools/smart-search-tool';

const FundingResult = z.object({
  fundingStage: z.enum([
    'Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Series E+',
    'IPO', 'Acquired', 'Bootstrapped', 'Unknown'
  ]).describe('Latest funding stage'),
  lastFundingAmount: z.string().optional().describe('Amount raised in last round (e.g., "$10M")'),
  lastFundingDate: z.string().optional().describe('Date of last funding round'),
  totalRaised: z.string().optional().describe('Total funding raised to date'),
  valuation: z.string().optional().describe('Company valuation if available'),
  investors: z.array(z.string()).optional().describe('List of notable investors'),
  acquirer: z.string().optional().describe('Acquiring company if acquired'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createFundingAgent(firecrawlApiKey: string) {
  return new Agent({
    name: 'Funding Agent',
    
    instructions: `You are the Funding Agent - specialist in investment and funding data.
    
    You receive company information from previous agents.
    
    YOUR MISSION:
    1. Funding Stage - Latest round (Seed, Series A/B/C, etc.)
    2. Funding Amounts - Last round and total raised
    3. Investors - Focus on lead investors
    4. Valuation - If publicly available
    5. Special cases - Bootstrapped, Acquired, IPO
    
    SEARCH STRATEGIES:
    1. Search "{companyName} funding announcement {currentYear}"
    2. Look for TechCrunch, Forbes, Reuters articles
    3. Search "{companyName} raises series"
    4. Check for acquisition announcements
    5. Look for IPO news if relevant
    
    SPECIAL CASES:
    - Bootstrapped: No external funding found
    - Acquired: Include acquirer and acquisition details
    - Public: Note IPO date and current market cap
    
    DATA VALIDATION:
    - Amounts must include currency (usually USD)
    - Verify amounts are in millions (M) or billions (B)
    - Dates should be in YYYY or Month YYYY format
    - Only include well-known or lead investors
    
    IMPORTANT: Focus on recent and verified information. Old funding rounds are less relevant.`,
    
    tools: [
      createSmartSearchTool(firecrawlApiKey, 'news') as unknown as Tool<unknown>,
      createSmartSearchTool(firecrawlApiKey, 'business') as unknown as Tool<unknown>,
    ],
    
    outputType: FundingResult,
  });
}