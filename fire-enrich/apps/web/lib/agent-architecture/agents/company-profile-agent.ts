import { Agent, Tool } from '@openai/agents';
import { z } from 'zod';
import { createWebsiteScraperTool } from '../tools/website-scraper-tool';
import { createSmartSearchTool } from '../tools/smart-search-tool';

const ProfileResult = z.object({
  industry: z.string().describe('Primary industry or sector'),
  headquarters: z.string().describe('Headquarters location (City, State/Country)'),
  yearFounded: z.number().min(1800).max(new Date().getFullYear()).describe('Year the company was founded'),
  companyType: z.enum(['Public', 'Private', 'Subsidiary', 'Non-profit', 'Unknown']).describe('Type of company'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createCompanyProfileAgent(firecrawlApiKey: string) {
  console.log('[AGENT-PROFILE] Creating Company Profile Agent');
  
  return new Agent({
    name: 'Company Profile Agent',
    
    instructions: `You are the Company Profile Agent - specialist in company background and characteristics.
    
    You receive company name and website from the Discovery Agent.
    
    YOUR MISSION:
    1. Industry/Sector - Use standard categories (SaaS, Fintech, Healthcare, etc.)
    2. Headquarters - City, State/Country format
    3. Year Founded - Must be reasonable (1800-current year)
    4. Company Type - Public, Private, Subsidiary, or Non-profit
    
    SEARCH STRATEGIES:
    1. First check the company website (About, Company, History pages)
    2. Search for "{companyName} headquarters founded year"
    3. Look for press releases or official announcements
    4. Search business news for company information
    
    VALIDATION RULES:
    - Industry: Use properly capitalized, recognized categories (e.g., "Technology", "Healthcare", "Finance", "E-commerce")
    - Location: Must be a real place with proper capitalization (e.g., "San Francisco, CA", "New York, NY")
    - Year: Must be between 1800 and current year
    - Company names: Use official capitalization (e.g., "OneTrust" not "onetrust", "Sideguide" not "SideGuide")
    - If uncertain, mark confidence as lower
    
    IMPORTANT: Build on the Discovery Agent's findings. Don't re-discover basic info.`,
    
    tools: [
      createWebsiteScraperTool(firecrawlApiKey) as unknown as Tool<unknown>,
      createSmartSearchTool(firecrawlApiKey, 'business') as unknown as Tool<unknown>,
    ],
    
    outputType: ProfileResult,
  });
}