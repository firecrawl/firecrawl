import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import FirecrawlApp from '@mendable/firecrawl-js';
import type { EnrichmentField } from '../types';

// Specialized search tool that each agent will use
const createSpecializedSearchTool = (firecrawl: FirecrawlApp) => tool({
  name: 'specialized_search',
  description: 'Search with domain-specific queries',
  parameters: z.object({
    queries: z.array(z.string()).describe('Multiple search queries to try'),
    scrapeContent: z.boolean().default(false),
  }),
  async execute({ queries, scrapeContent }) {
    const allResults = [];
    
    for (const query of queries) {
      try {
        const options: { limit: number; scrapeOptions?: { formats: string[] } } = { limit: 3 };
        if (scrapeContent) {
          options.scrapeOptions = { formats: ['markdown'] };
        }
        
        const results = await firecrawl.v1.search(query, options);
        allResults.push(...(results.data ?? []));
      } catch (error) {
        console.error(`Search failed for query "${query}":`, error);
      }
    }
    
    // Deduplicate by URL
    const uniqueResults = Array.from(
      new Map(allResults.map(r => [r.url, r])).values()
    );
    
    return uniqueResults.map(item => ({
      title: item.title || '',
      url: item.url,
      content: scrapeContent ? item.markdown : item.description,
    }));
  },
});

// Company Information Agent
export function createCompanyAgent(firecrawl: FirecrawlApp) {
  return new Agent({
    name: 'Company Research Specialist',
    instructions: `You are an expert at finding company information. You know:
    
    1. How to construct effective search queries for company data
    2. Common patterns in company information (headquarters, employee counts, industries)
    3. How to validate company data for accuracy
    
    When searching for a company:
    - Try multiple query variations
    - Look for official company pages, LinkedIn, Crunchbase
    - Validate employee counts (startups usually < 1000, only large corps > 10000)
    - Normalize industry names to standard categories
    
    Output structured data with confidence scores for each field.`,
    tools: [createSpecializedSearchTool(firecrawl)],
    outputType: z.object({
      companyName: z.string().optional(),
      website: z.string().url().optional(),
      industry: z.string().optional(),
      headquarters: z.string().optional(),
      employeeCount: z.number().optional(),
      yearFounded: z.number().min(1800).max(2024).optional(),
      description: z.string().optional(),
      confidence: z.record(z.string(), z.number().min(0).max(1)),
      sources: z.array(z.string()),
    }),
  });
}

// Fundraising Intelligence Agent
export function createFundraisingAgent(firecrawl: FirecrawlApp) {
  return new Agent({
    name: 'Fundraising Intelligence Specialist',
    instructions: `You are an expert at finding funding and investment information. You know:
    
    1. Funding stage progression: Pre-seed → Seed → Series A → B → C → D → E+ → IPO
    2. How to find funding announcements, investor information, valuations
    3. Common funding data sources (Crunchbase, TechCrunch, company announcements)
    
    When searching for funding information:
    - Search for "[company] funding", "[company] series", "[company] investment"
    - Look for recent funding rounds and total raised
    - Identify lead investors and valuation if available
    - Normalize funding stages to standard terms
    
    Be careful with amounts - verify if it's in millions or billions.`,
    tools: [createSpecializedSearchTool(firecrawl)],
    outputType: z.object({
      lastFundingStage: z.enum(['Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Series E+', 'IPO', 'Unknown']).optional(),
      lastFundingAmount: z.string().optional(), // String to handle "$10M" format
      lastFundingDate: z.string().optional(),
      totalRaised: z.string().optional(),
      valuation: z.string().optional(),
      leadInvestors: z.array(z.string()).optional(),
      allInvestors: z.array(z.string()).optional(),
      confidence: z.record(z.string(), z.number().min(0).max(1)),
      sources: z.array(z.string()),
    }),
  });
}

// People & Leadership Agent
export function createPeopleAgent(firecrawl: FirecrawlApp) {
  return new Agent({
    name: 'Executive & People Research Specialist',
    instructions: `You are an expert at finding information about company leadership and key people. You know:
    
    1. Common executive titles (CEO, CTO, CFO, COO, VP, Director)
    2. How to find leadership information (company about pages, LinkedIn, press releases)
    3. How to identify founders vs. hired executives
    
    When searching for people:
    - Search for "[company] CEO", "[company] leadership team", "[company] founders"
    - Look for LinkedIn profiles when available
    - Identify both current and founding team members
    - Extract previous company experience if mentioned`,
    tools: [createSpecializedSearchTool(firecrawl)],
    outputType: z.object({
      ceo: z.object({
        name: z.string(),
        linkedin: z.string().url().optional(),
        previousCompany: z.string().optional(),
      }).optional(),
      founders: z.array(z.object({
        name: z.string(),
        role: z.string().optional(),
        linkedin: z.string().url().optional(),
      })).optional(),
      keyExecutives: z.array(z.object({
        name: z.string(),
        title: z.string(),
        linkedin: z.string().url().optional(),
      })).optional(),
      boardMembers: z.array(z.string()).optional(),
      employeeCount: z.number().optional(),
      confidence: z.record(z.string(), z.number().min(0).max(1)),
      sources: z.array(z.string()),
    }),
  });
}

// Product & Technology Agent
export function createProductAgent(firecrawl: FirecrawlApp) {
  return new Agent({
    name: 'Product & Technology Research Specialist',
    instructions: `You are an expert at finding product and technology information. You know:
    
    1. How to identify main products and services
    2. Technology stacks and platforms
    3. Competitive landscape and market positioning
    
    When searching for product info:
    - Search for "[company] products", "[company] platform", "[company] technology"
    - Look for product pages, technical blogs, job postings (for tech stack)
    - Identify both B2B and B2C offerings
    - Find main competitors and differentiators`,
    tools: [createSpecializedSearchTool(firecrawl)],
    outputType: z.object({
      mainProducts: z.array(z.string()).optional(),
      targetMarket: z.enum(['B2B', 'B2C', 'B2B2C', 'Both']).optional(),
      techStack: z.array(z.string()).optional(),
      competitors: z.array(z.string()).optional(),
      uniqueSellingPoints: z.array(z.string()).optional(),
      pricingModel: z.string().optional(),
      confidence: z.record(z.string(), z.number().min(0).max(1)),
      sources: z.array(z.string()),
    }),
  });
}

// Contact & Social Media Agent
export function createContactAgent(firecrawl: FirecrawlApp) {
  return new Agent({
    name: 'Contact Information Specialist',
    instructions: `You are an expert at finding contact and social media information. You know:
    
    1. Where to find official contact information
    2. Social media platform patterns
    3. How to identify official vs. fan accounts
    
    When searching for contacts:
    - Look for official website contact pages
    - Find verified social media accounts
    - Extract email patterns if visible
    - Get physical addresses for headquarters`,
    tools: [createSpecializedSearchTool(firecrawl)],
    outputType: z.object({
      emails: z.array(z.string().email()).optional(),
      phones: z.array(z.string()).optional(),
      address: z.string().optional(),
      socialMedia: z.object({
        linkedin: z.string().url().optional(),
        twitter: z.string().url().optional(),
        facebook: z.string().url().optional(),
        instagram: z.string().url().optional(),
        youtube: z.string().url().optional(),
      }).optional(),
      confidence: z.record(z.string(), z.number().min(0).max(1)),
      sources: z.array(z.string()),
    }),
  });
}

// Master Enrichment Coordinator that uses specialized agents
export function createEnrichmentCoordinator(
  firecrawl: FirecrawlApp,
  fields: EnrichmentField[]
) {
  // Determine which specialized agents to use based on requested fields
  const agents = [];
  const fieldNames = fields.map(f => f.name.toLowerCase());
  const fieldDescriptions = fields.map(f => f.description.toLowerCase()).join(' ');
  
  // Add agents based on requested fields
  if (fieldNames.some(n => n.includes('company') || n.includes('industry') || n.includes('employee')) ||
      fieldDescriptions.includes('company') || fieldDescriptions.includes('industry')) {
    agents.push(createCompanyAgent(firecrawl));
  }
  
  if (fieldNames.some(n => n.includes('fund') || n.includes('invest') || n.includes('valuation')) ||
      fieldDescriptions.includes('funding') || fieldDescriptions.includes('investment')) {
    agents.push(createFundraisingAgent(firecrawl));
  }
  
  if (fieldNames.some(n => n.includes('ceo') || n.includes('founder') || n.includes('executive')) ||
      fieldDescriptions.includes('leadership') || fieldDescriptions.includes('founder')) {
    agents.push(createPeopleAgent(firecrawl));
  }
  
  if (fieldNames.some(n => n.includes('product') || n.includes('service') || n.includes('tech')) ||
      fieldDescriptions.includes('product') || fieldDescriptions.includes('technology')) {
    agents.push(createProductAgent(firecrawl));
  }
  
  if (fieldNames.some(n => n.includes('email') || n.includes('phone') || n.includes('social')) ||
      fieldDescriptions.includes('contact') || fieldDescriptions.includes('social')) {
    agents.push(createContactAgent(firecrawl));
  }
  
  // If no specific agents matched, use company agent as default
  if (agents.length === 0) {
    agents.push(createCompanyAgent(firecrawl));
  }

  return Agent.create({
    name: 'Enrichment Coordinator',
    instructions: `You coordinate specialized agents to gather information based on the requested fields.
    
    Requested fields:
    ${fields.map(f => `- ${f.name}: ${f.description}`).join('\n')}
    
    Process:
    1. Parse the provided context (email, company name, etc.)
    2. Delegate to specialized agents based on the requested fields
    3. Compile results from all agents
    4. Map the agent results to the requested field names
    5. Return consolidated data with confidence scores
    
    Important: Map the data from agents to match the exact field names requested.`,
    handoffs: agents,
    outputType: createDynamicOutputSchema(fields),
  });
}

// Helper function to create dynamic output schema based on requested fields
function createDynamicOutputSchema(fields: EnrichmentField[]) {
  const schemaFields: Record<string, z.ZodTypeAny> = {};
  
  fields.forEach(field => {
    let fieldSchema: z.ZodTypeAny;
    
    switch (field.type) {
      case 'string':
        fieldSchema = z.string();
        break;
      case 'number':
        fieldSchema = z.number();
        break;
      case 'boolean':
        fieldSchema = z.boolean();
        break;
      case 'array':
        fieldSchema = z.array(z.string());
        break;
      default:
        fieldSchema = z.string();
    }
    
    schemaFields[field.name] = field.required ? fieldSchema : fieldSchema.optional();
  });
  
  // Add metadata fields
  schemaFields._confidence = z.record(z.string(), z.number().min(0).max(1));
  schemaFields._sources = z.record(z.string(), z.array(z.string()));
  
  return z.object(schemaFields);
}

// Service class to use the specialized agents
export class SpecializedAgentService {
  private firecrawl: FirecrawlApp;
  private apiKey: string;

  constructor(apiKey: string, firecrawlApiKey: string) {
    this.apiKey = apiKey;
    this.firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey, apiUrl: process.env.FIRECRAWL_API_URL });
  }

  async enrichWithSpecializedAgents(
    context: Record<string, string>,
    fields: EnrichmentField[]
  ) {
    // For now, use individual agents based on field patterns
    // TODO: In the future, use coordinator agent with proper handoffs
    const enrichmentResults: Record<string, { value: unknown; confidence: number; sources: string[] }> = {};
    
    for (const field of fields) {
      try {
        let agentToUse = null;
        const fieldNameLower = field.name.toLowerCase();
        const fieldDescLower = field.description.toLowerCase();
        
        if (fieldNameLower.includes('company') || fieldDescLower.includes('company')) {
          agentToUse = this.getCompanyAgent();
        } else if (fieldNameLower.includes('fund') || fieldDescLower.includes('fund')) {
          agentToUse = this.getFundraisingAgent();
        } else if (fieldNameLower.includes('people') || fieldNameLower.includes('ceo') || fieldNameLower.includes('founder')) {
          agentToUse = this.getPeopleAgent();
        } else if (fieldNameLower.includes('product') || fieldDescLower.includes('product')) {
          agentToUse = this.getProductAgent();
        } else if (fieldNameLower.includes('contact') || fieldNameLower.includes('social')) {
          agentToUse = this.getContactAgent();
        }
        
        if (agentToUse) {
          const result = await agentToUse.run(`Find ${field.description} for: ${JSON.stringify(context)}`, {
            apiKey: this.apiKey,
          });
          
          // Extract relevant value from agent output
          const output = result.finalOutput as Record<string, unknown>;
          enrichmentResults[field.name] = {
            value: output[field.name] || output.data || output,
            confidence: 0.8,
            sources: Array.isArray(output.sources) ? output.sources as string[] : []
          };
        }
      } catch (error) {
        console.error(`Error getting field ${field.name}:`, error);
        enrichmentResults[field.name] = {
          value: null,
          confidence: 0,
          sources: []
        };
      }
    }
    
    return enrichmentResults;
  }

  private transformAgentResult(agentOutput: Record<string, unknown>, fields: EnrichmentField[]) {
    const enrichmentResults: Record<string, { value: unknown; confidence: number; sources: string[] }> = {};
    
    fields.forEach(field => {
      if (field.name in agentOutput) {
        enrichmentResults[field.name] = {
          value: agentOutput[field.name],
          confidence: (agentOutput._confidence as Record<string, number>)?.[field.name] || 0.7,
          sources: (agentOutput._sources as Record<string, string[]>)?.[field.name] || [],
        };
      }
    });
    
    return enrichmentResults;
  }

  // Get a specific specialized agent for direct use
  getCompanyAgent() {
    return createCompanyAgent(this.firecrawl);
  }

  getFundraisingAgent() {
    return createFundraisingAgent(this.firecrawl);
  }

  getPeopleAgent() {
    return createPeopleAgent(this.firecrawl);
  }

  getProductAgent() {
    return createProductAgent(this.firecrawl);
  }

  getContactAgent() {
    return createContactAgent(this.firecrawl);
  }
}