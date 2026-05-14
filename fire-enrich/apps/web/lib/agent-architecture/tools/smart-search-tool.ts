import { z } from 'zod';
import FirecrawlApp from '@mendable/firecrawl-js';

export type SearchType = 'discovery' | 'business' | 'news' | 'technical' | 'metrics';

interface SearchContext {
  companyName?: string;
  companyDomain?: string;
  industry?: string;
  location?: string;
}

interface SearchResult {
  url: string;
  title?: string;
  markdown?: string;
  content?: string;
}

interface ProcessedResult extends SearchResult {
  relevance: number;
  domain: string;
}

export function createSmartSearchTool(firecrawlApiKey: string, searchType: SearchType, onProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void) {
  const firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey, apiUrl: process.env.FIRECRAWL_API_URL });
  
  return {
    name: `search_${searchType}`,
    description: `Smart search for ${searchType} information using Firecrawl SERP that returns markdown contents of page results`,
    parameters: z.object({
      queries: z.array(z.string()).describe('Search queries to try'),
      targetField: z.string().describe('The field we are trying to enrich'),
      context: z.object({
        companyName: z.string().optional(),
        companyDomain: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
      }).optional().describe('Context to enhance search queries'),
    }),
    
    async execute({ queries, targetField, context }: { queries: string[]; targetField: string; context?: SearchContext }) {
      const allResults: ProcessedResult[] = [];
      
      for (const query of queries) {
        try {
          // Enhance query based on search type and context
          const enhancedQuery = enhanceQuery(query, searchType, context);
          
          console.log(`🔍 Searching: ${enhancedQuery}`);
          if (onProgress) {
            onProgress(`Executing search: ${enhancedQuery.substring(0, 80)}...`, 'info');
          }
          
          const results = await firecrawl.v1.search(enhancedQuery, {
            limit: searchType === 'discovery' ? 3 : 5,
            scrapeOptions: {
              formats: ['markdown'],
              onlyMainContent: true,
            }
          });
          
          // Process and rank results
          if (results && results.data && Array.isArray(results.data)) {
            if (onProgress) {
              onProgress(`Processing ${results.data.length} results from search`, 'info');
            }
            for (const result of results.data) {
              if (!result || !result.url) continue;
              
              const relevance = calculateRelevance({
                url: result.url || '',
                title: result.title,
                markdown: result.markdown,
                content: result.markdown
              }, targetField, context, searchType);
              
              allResults.push({
                url: result.url,
                title: result.title || '',
                content: result.markdown || '',
                relevance,
                domain: new URL(result.url).hostname,
              });
            }
          } else {
            console.log(`No results returned for query: ${enhancedQuery}`);
          }
        } catch (error) {
          console.error(`Search failed for query: ${query}`, error instanceof Error ? error.message : String(error));
        }
      }
      
      // Sort by relevance and deduplicate by domain
      const uniqueResults = deduplicateByDomain(allResults)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10);
      
      if (onProgress) {
        onProgress(`Ranked ${uniqueResults.length} unique results by relevance`, 'success');
      }
      
      return uniqueResults;
    },
  };
}

function enhanceQuery(query: string, searchType: SearchType, context?: SearchContext): string {
  let enhanced = query;
  
  // Add year for time-sensitive searches
  if (searchType === 'metrics' || searchType === 'news') {
    const year = new Date().getFullYear();
    if (!query.includes(year.toString())) {
      enhanced += ` ${year}`;
    }
  }
  
  // Add location context if available
  if (context?.location && searchType === 'business') {
    enhanced += ` ${context.location}`;
  }
  
  // Add industry context for technical searches
  if (context?.industry && searchType === 'technical') {
    enhanced += ` ${context.industry}`;
  }
  
  return enhanced;
}

function calculateRelevance(
  result: SearchResult, 
  _targetField: string, 
  context: SearchContext | undefined,
  searchType: SearchType
): number {
  let score = 0.5; // Base score
  
  const url = result.url.toLowerCase();
  const domain = new URL(result.url).hostname.toLowerCase();
  
  // Boost for company's own domain
  if (context?.companyDomain && domain.includes(context.companyDomain.toLowerCase())) {
    score += 0.3;
  }
  
  // Boost for trusted sources based on search type
  const trustedSources = {
    discovery: ['about', 'company', 'who-we-are'],
    business: ['crunchbase', 'pitchbook', 'zoominfo', 'dnb.com'],
    news: ['techcrunch', 'forbes', 'reuters', 'bloomberg', 'businesswire'],
    technical: ['github', 'producthunt', 'g2.com', 'capterra'],
    metrics: ['linkedin', 'glassdoor', 'indeed', 'builtin'],
  };
  
  const relevantSources = trustedSources[searchType] || [];
  if (relevantSources.some(source => url.includes(source))) {
    score += 0.2;
  }
  
  // Boost for recent content (check if title/content contains recent year)
  const currentYear = new Date().getFullYear();
  const recentYears = [currentYear, currentYear - 1];
  const contentText = (result.title + ' ' + (result.content || '')).toLowerCase();
  
  if (recentYears.some(year => contentText.includes(year.toString()))) {
    score += 0.1;
  }
  
  // Penalty for obviously irrelevant domains
  const irrelevantDomains = ['wikipedia.org', 'facebook.com', 'twitter.com', 'instagram.com'];
  if (irrelevantDomains.some(domain => url.includes(domain))) {
    score -= 0.3;
  }
  
  return Math.max(0, Math.min(1, score));
}

function deduplicateByDomain(results: ProcessedResult[]): ProcessedResult[] {
  const seen = new Map<string, ProcessedResult>();
  
  for (const result of results) {
    const existing = seen.get(result.domain);
    if (!existing || result.relevance > existing.relevance) {
      seen.set(result.domain, result);
    }
  }
  
  return Array.from(seen.values());
}