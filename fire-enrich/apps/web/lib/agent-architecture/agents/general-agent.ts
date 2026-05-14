import { EnrichmentField, EnrichmentResult } from '../core/types';

interface GeneralAgentContext {
  companyName?: string;
  discoveredData?: Record<string, unknown>;
  emailContext?: {
    companyDomain?: string;
    companyNameGuess?: string;
  };
}

interface GeneralAgentTools {
  search: (query: string, options?: { limit?: number; scrapeOptions?: { formats?: string[] } }) => Promise<SearchResult[]>;
  scrape: (url: string) => Promise<ScrapeResult>;
  extractStructuredData: (content: string, fields: EnrichmentField[], context: unknown) => Promise<Record<string, EnrichmentResult>>;
}

interface SearchResult {
  url: string;
  title?: string;
  markdown?: string;
  content?: string;
}

interface ScrapeResult {
  success: boolean;
  markdown?: string;
  html?: string;
}

export class GeneralAgent {
  name = 'general-agent';
  description = 'Handles miscellaneous fields that don\'t fit into specific categories like executives, custom data points, etc.';
  private tools: GeneralAgentTools;

  constructor(tools: GeneralAgentTools) {
    this.tools = tools;
  }

  async execute(
    context: GeneralAgentContext,
    fields: EnrichmentField[]
  ): Promise<Record<string, EnrichmentResult>> {
    console.log('[AGENT-GENERAL] Starting General Information Phase');
    
    const companyName = context.companyName || 
                       context.discoveredData?.companyName ||
                       context.emailContext?.companyNameGuess;
    
    const companyDomain = context.emailContext?.companyDomain;
    
    console.log(`[AGENT-GENERAL] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Company domain: ${companyDomain || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (!companyName && !companyDomain) {
      console.log('[AGENT-GENERAL] No company name or domain available, skipping general phase');
      return {};
    }
    
    const results: Record<string, EnrichmentResult> = {};
    
    try {
      // Build search queries based on the fields requested
      const searchQueries = this.buildSearchQueries(fields, companyName as string | undefined, companyDomain);
      
      console.log(`[AGENT-GENERAL] Built ${searchQueries.length} search queries`);
      
      let allSearchResults: SearchResult[] = [];
      
      for (const query of searchQueries) {
        try {
          console.log(`[AGENT-GENERAL] Searching: ${query}`);
          const searchResults = await this.tools.search(query, { 
            limit: 3,
            scrapeOptions: { formats: ['markdown'] }
          });
          
          if (searchResults && searchResults.length > 0) {
            console.log(`[AGENT-GENERAL] Found ${searchResults.length} results`);
            allSearchResults = allSearchResults.concat(searchResults);
          }
        } catch (error) {
          console.log(`[AGENT-GENERAL] Search failed for query "${query}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Also try to scrape the company website for executive info
      if (companyDomain && this.hasExecutiveFields(fields)) {
        try {
          console.log(`[AGENT-GENERAL] Scraping company website for executive info`);
          const aboutUrl = `https://${companyDomain}/about`;
          const teamUrl = `https://${companyDomain}/team`;
          const leadershipUrl = `https://${companyDomain}/leadership`;
          
          for (const url of [aboutUrl, teamUrl, leadershipUrl]) {
            try {
              const scraped = await this.tools.scrape(url);
              if (scraped.success && scraped.markdown) {
                allSearchResults.push({
                  url,
                  title: 'Company Leadership Page',
                  markdown: scraped.markdown,
                  content: scraped.markdown
                });
                console.log(`[AGENT-GENERAL] Successfully scraped ${url}`);
                break; // Stop after first successful scrape
              }
            } catch (error) {
              // Continue to next URL
              console.log(`[AGENT-GENERAL] Failed to scrape ${url}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          console.log(`[AGENT-GENERAL] Failed to scrape company website: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Deduplicate by URL
      const uniqueResults = Array.from(
        new Map(allSearchResults.map(r => [r.url, r])).values()
      );
      
      console.log(`[AGENT-GENERAL] Total unique results: ${uniqueResults.length}`);
      
      if (uniqueResults.length === 0) {
        console.log('[AGENT-GENERAL] No search results found');
        return {};
      }
      
      // Combine content for extraction
      const combinedContent = uniqueResults
        .slice(0, 10) // Limit to top 10 results
        .map(r => `URL: ${r.url}\nTitle: ${r.title || 'No title'}\nContent:\n${r.markdown || r.content || ''}`)
        .filter(Boolean)
        .join('\n\n---\n\n');
      
      // Extract structured data
      const enrichmentContext = {
        companyName,
        companyDomain,
        targetDomain: companyDomain,
        instruction: `Extract the requested information about ${companyName || companyDomain}.
        
        For executive names (CEO, CTO, CFO, etc.):
        - Look for mentions like "CEO", "Chief Executive Officer", "founder and CEO", etc.
        - Extract the person's full name
        - Be careful to match the title exactly as requested
        
        For other custom fields:
        - Extract exactly what is asked for
        - Only include information that is explicitly stated
        - Do not make assumptions or inferences`,
        ...(context as Record<string, unknown>)
      };
      
      const enrichmentResults = await this.tools.extractStructuredData(
        combinedContent,
        fields,
        enrichmentContext
      );
      
      // Process results
      for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
        if (enrichment && enrichment.value) {
          results[fieldName] = enrichment;
        }
      }
      
      console.log(`[AGENT-GENERAL] Extracted ${Object.keys(results).length} fields`);
      
    } catch (error) {
      console.error('[AGENT-GENERAL] Error during general information extraction:', error);
    }
    
    return results;
  }
  
  private buildSearchQueries(fields: EnrichmentField[], companyName?: string, companyDomain?: string): string[] {
    const queries: string[] = [];
    
    // Group fields by type
    const executiveFields = fields.filter(f => this.isExecutiveField(f));
    const otherFields = fields.filter(f => !this.isExecutiveField(f));
    
    // Build queries for executive fields
    if (executiveFields.length > 0) {
      const titles = executiveFields.map(f => this.extractTitle(f)).filter(Boolean);
      
      if (companyName) {
        queries.push(`"${companyName}" leadership team executives ${titles.join(' ')}`);
        queries.push(`"${companyName}" CEO CTO CFO founders management team`);
        queries.push(`site:linkedin.com/in "${companyName}" ${titles.join(' OR ')}`);
      }
      
      if (companyDomain) {
        queries.push(`site:${companyDomain} team leadership about executives`);
      }
    }
    
    // Build queries for other fields
    for (const field of otherFields) {
      const fieldTerms = this.getSearchTermsForField(field);
      
      if (companyName) {
        queries.push(`"${companyName}" ${fieldTerms}`);
      }
      
      if (companyDomain) {
        queries.push(`site:${companyDomain} ${fieldTerms}`);
      }
    }
    
    // Add news search for recent information
    if (companyName && fields.length > 0) {
      queries.push(`"${companyName}" news announcement ${new Date().getFullYear()}`);
    }
    
    return queries;
  }
  
  private hasExecutiveFields(fields: EnrichmentField[]): boolean {
    return fields.some(f => this.isExecutiveField(f));
  }
  
  private isExecutiveField(field: EnrichmentField): boolean {
    const name = field.name.toLowerCase();
    const desc = field.description.toLowerCase();
    
    const executiveTitles = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'cpo', 'chief', 'founder', 'president', 'director'];
    
    return executiveTitles.some(title => name.includes(title) || desc.includes(title));
  }
  
  private extractTitle(field: EnrichmentField): string {
    const name = field.name.toLowerCase();
    const desc = field.description.toLowerCase();
    
    // Map common variations to standard titles
    if (name.includes('ceo') || desc.includes('chief executive')) return 'CEO';
    if (name.includes('cto') || desc.includes('chief technology')) return 'CTO';
    if (name.includes('cfo') || desc.includes('chief financial')) return 'CFO';
    if (name.includes('coo') || desc.includes('chief operating')) return 'COO';
    if (name.includes('cmo') || desc.includes('chief marketing')) return 'CMO';
    if (name.includes('cpo') || desc.includes('chief product')) return 'CPO';
    if (name.includes('founder')) return 'founder';
    if (name.includes('president')) return 'president';
    
    return field.name;
  }
  
  private getSearchTermsForField(field: EnrichmentField): string {
    // Generate search terms based on field name and description
    const terms = [field.name];
    
    // Add related terms from description
    if (field.description) {
      // Extract key phrases from description
      const keyPhrases = field.description
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !['this', 'that', 'what', 'when', 'where', 'which'].includes(word));
      
      terms.push(...keyPhrases.slice(0, 3)); // Add top 3 key words
    }
    
    return terms.join(' ');
  }
}