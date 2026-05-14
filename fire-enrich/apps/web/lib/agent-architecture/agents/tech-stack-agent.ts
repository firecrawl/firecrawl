import { EnrichmentField, EnrichmentResult } from '../core/types';

interface TechStackAgentContext {
  companyName?: string;
  discoveredData?: Record<string, unknown>;
  emailContext?: {
    companyDomain?: string;
    companyNameGuess?: string;
  };
}

interface TechStackAgentTools {
  search: (query: string, options?: { limit?: number; scrapeOptions?: { formats?: string[] } }) => Promise<SearchResult[]>;
  scrape: (url: string) => Promise<ScrapeResult>;
  extractStructuredData: (content: string, fields: EnrichmentField[], context: unknown) => Promise<Record<string, EnrichmentResult>>;
}

interface SearchResult {
  url: string;
  title?: string;
  markdown?: string;
  content?: string;
  description?: string;
}

interface ScrapeResult {
  success: boolean;
  markdown?: string;
  html?: string;
}

export class TechStackAgent {
  name = 'tech-stack-agent';
  description = 'Discovers technology stack, programming languages, and frameworks used by the company';
  private tools: TechStackAgentTools;

  constructor(tools: TechStackAgentTools) {
    this.tools = tools;
  }

  async execute(
    context: TechStackAgentContext,
    fields: EnrichmentField[]
  ): Promise<Record<string, EnrichmentResult>> {
    console.log('[AGENT-TECH-STACK] Starting Tech Stack Phase');
    
    const companyName = context.companyName || 
                       context.discoveredData?.companyName ||
                       context.emailContext?.companyNameGuess;
    
    const companyDomain = context.emailContext?.companyDomain;
    
    console.log(`[AGENT-TECH-STACK] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-TECH-STACK] Company domain: ${companyDomain || 'Not found'}`);
    console.log(`[AGENT-TECH-STACK] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (!companyName && !companyDomain) {
      console.log('[AGENT-TECH-STACK] No company name or domain available, skipping tech stack phase');
      return {};
    }
    
    const results: Record<string, EnrichmentResult> = {};
    
    try {
      // Search for GitHub repositories
      const githubQuery = companyName 
        ? `site:github.com "${companyName}" OR "${(companyName as string).toLowerCase().replace(/\s+/g, '-')}"`
        : `site:github.com "${companyDomain?.replace('.com', '').replace('.io', '').replace('.ai', '')}"`;
      
      console.log(`[AGENT-TECH-STACK] GitHub search query: ${githubQuery}`);
      
      const githubResults = await this.tools.search(githubQuery, { limit: 3 });
      console.log(`[AGENT-TECH-STACK] Found ${githubResults.length} GitHub results`);
      
      // Also search for tech stack information on their website
      let websiteContent = '';
      let websiteHtml = '';
      
      if (companyDomain) {
        try {
          console.log(`[AGENT-TECH-STACK] Scraping company website for tech info: https://${companyDomain}`);
          const websiteData = await this.tools.scrape(`https://${companyDomain}`);
          if (websiteData.success) {
            websiteContent = websiteData.markdown || '';
            websiteHtml = websiteData.html || '';
            console.log(`[AGENT-TECH-STACK] Website scrape successful, content length: ${websiteContent.length}`);
          }
        } catch (error) {
          console.log(`[AGENT-TECH-STACK] Website scrape failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Search for tech stack mentions
      const techSearchQuery = `"${companyName || companyDomain}" "tech stack" "built with" "powered by" "technologies" "programming languages" framework`;
      console.log(`[AGENT-TECH-STACK] Tech stack search query: ${techSearchQuery}`);
      
      const techResults = await this.tools.search(techSearchQuery, { limit: 3 });
      console.log(`[AGENT-TECH-STACK] Found ${techResults.length} tech stack results`);
      
      // Combine all content for extraction
      const allContent = [
        ...githubResults.map(r => `URL: ${r.url}\nTitle: ${r.title}\nContent:\n${r.markdown || r.description}`),
        ...techResults.map(r => `URL: ${r.url}\nTitle: ${r.title}\nContent:\n${r.markdown || r.description}`),
        websiteContent ? `URL: https://${companyDomain}\nTitle: Company Website\nContent:\n${websiteContent}` : ''
      ].filter(Boolean).join('\n\n---\n\n');
      
      // Extract structured data using OpenAI
      const enrichmentResults = await this.tools.extractStructuredData(
        allContent,
        fields,
        {
          companyName,
          companyDomain,
          instruction: 'Focus on extracting technology stack, programming languages, frameworks, and tools used by the company. Look for GitHub repositories, technology mentions, and development tools.'
        } as unknown
      );
      
      // Process results
      for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
        if (enrichment && enrichment.value) {
          results[fieldName] = enrichment;
          
          // Add HTML field if requested
          const htmlField = fields.find((f: EnrichmentField) => 
            f.name.toLowerCase().includes('html') || 
            f.name.toLowerCase().includes('webpage')
          );
          
          if (htmlField && websiteHtml) {
            results[htmlField.name] = {
              field: htmlField.name,
              value: websiteHtml.substring(0, 50000), // Limit HTML size
              confidence: 1.0,
              source: `https://${companyDomain}`,
              sourceContext: [{
                url: `https://${companyDomain}`,
                snippet: 'Full HTML content of company website'
              }]
            };
          }
        }
      }
      
      console.log(`[AGENT-TECH-STACK] Extracted ${Object.keys(results).length} tech stack fields`);
      
    } catch (error) {
      console.error('[AGENT-TECH-STACK] Error during tech stack discovery:', error);
    }
    
    return results;
  }
}