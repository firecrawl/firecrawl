import { z } from 'zod';
import FirecrawlApp from '@mendable/firecrawl-js';

interface ScrapeResult {
  success: boolean;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export function createWebsiteScraperTool(firecrawlApiKey: string, onProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void) {
  const firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey, apiUrl: process.env.FIRECRAWL_API_URL });
  
  return {
    name: 'scrape_website',
    description: 'Scrape a specific webpage for information',
    parameters: z.object({
      url: z.string().url().describe('URL to scrape'),
      targetFields: z.array(z.string()).describe('Fields we are looking for'),
      selectors: z.object({
        about: z.array(z.string()).optional(),
        contact: z.array(z.string()).optional(),
        team: z.array(z.string()).optional(),
      }).optional().describe('CSS selectors to focus on specific sections'),
    }),
    
    async execute({ url, targetFields }: { url: string; targetFields: string[]; selectors?: { about?: string[]; contact?: string[]; team?: string[] } }) {
      try {
        console.log(`🌐 Scraping: ${url}`);
        if (onProgress) {
          onProgress(`Starting to scrape ${url}`, 'info');
        }
        
        const result = await firecrawl.v1.scrapeUrl(url, {
          formats: ['markdown', 'html'],
          onlyMainContent: true,
          waitFor: 2000, // Wait for dynamic content
        });
        
        if (!result.success) {
          throw new Error(`Failed to scrape ${url}`);
        }
        
        if (onProgress) {
          onProgress(`Successfully scraped ${url} (${result.markdown?.length || 0} chars)`, 'success');
        }
        
        // Extract structured data from the page
        const extractedData: Record<string, unknown> = {};
        if (onProgress) {
          onProgress(`Extracting ${targetFields.length} fields from scraped content...`, 'info');
        }
        
        // Try to extract company name from various sources
        if (targetFields.includes('Company Name') || targetFields.includes('companyName')) {
          extractedData.companyName = extractCompanyName(result);
        }
        
        // Extract description
        if (targetFields.includes('Company Description') || targetFields.includes('description')) {
          extractedData.description = extractDescription(result);
        }
        
        // Extract location/headquarters
        if (targetFields.includes('Location') || targetFields.includes('headquarters')) {
          extractedData.location = extractLocation(result);
        }
        
        // Extract industry
        if (targetFields.includes('Industry') || targetFields.includes('industry')) {
          extractedData.industry = extractIndustry(result);
        }
        
        const extractedCount = Object.keys(extractedData).length;
        if (onProgress && extractedCount > 0) {
          onProgress(`Extracted ${extractedCount} fields from website`, 'success');
        }
        
        return {
          url,
          extractedData,
          rawContent: result.markdown?.substring(0, 5000), // Limit size
          metadata: result.metadata,
        };
      } catch (error) {
        console.error(`Failed to scrape ${url}:`, error);
        if (onProgress) {
          onProgress(`Failed to scrape ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'warning');
        }
        return {
          url,
          error: error instanceof Error ? error.message : 'Unknown error',
          extractedData: {},
        };
      }
    },
  };
}

function extractCompanyName(result: ScrapeResult): string | null {
  const markdown = result.markdown || '';
  const metadata = result.metadata || {};
  
  // Try metadata first
  if (metadata.title && typeof metadata.title === 'string') {
    // Clean common suffixes
    const cleaned = metadata.title
      .replace(/\s*[\||-]\s*Official\s*(Website|Site)?\s*$/i, '')
      .replace(/\s*[\||-]\s*Home\s*$/i, '')
      .replace(/\s*[\||-]\s*About\s*.*$/i, '')
      .trim();
    
    if (cleaned && cleaned.length > 2 && cleaned.length < 100) {
      return cleaned;
    }
  }
  
  // Look for h1 headers
  const h1Match = markdown.match(/^#\s+([^#\n]+)/m);
  if (h1Match) {
    const h1Text = h1Match[1].trim();
    if (h1Text.length > 2 && h1Text.length < 100) {
      return h1Text;
    }
  }
  
  // Look for "About [Company]" patterns
  const aboutMatch = markdown.match(/About\s+([A-Z][A-Za-z0-9\s&.-]+?)(?:\s*[\n|,.])/);
  if (aboutMatch) {
    return aboutMatch[1].trim();
  }
  
  return null;
}

function extractDescription(result: ScrapeResult): string | null {
  const markdown = result.markdown || '';
  const metadata = result.metadata || {};
  
  // Try meta description first
  if (metadata.description && typeof metadata.description === 'string' && metadata.description.length > 20) {
    return metadata.description as string;
  }
  
  // Look for mission/about sections
  const patterns = [
    /(?:Our\s+)?(?:Mission|Vision|About|Who\s+We\s+Are)[\s:]+([^\n]+(?:\n[^\n]+){0,2})/i,
    /We\s+(?:are|help|provide|build|create)\s+([^\n]+(?:\n[^\n]+){0,2})/i,
    /^([A-Z][^.!?]+(?:help|provide|build|create|enable|empower)[^.!?]+[.!?])/m,
  ];
  
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match) {
      const desc = match[1].trim()
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ');
      
      if (desc.length > 30 && desc.length < 500) {
        return desc;
      }
    }
  }
  
  // Fall back to first substantive paragraph
  const paragraphs = markdown.split(/\n\n+/).filter((p) => p.length > 50);
  if (paragraphs.length > 0) {
    return paragraphs[0].substring(0, 300).trim();
  }
  
  return null;
}

function extractLocation(result: ScrapeResult): string | null {
  const markdown = result.markdown || '';
  
  // Location patterns
  const patterns = [
    /(?:Headquarters|HQ|Based\s+in|Located\s+in)[\s:]+([A-Za-z\s,]+?)(?:\n|$)/i,
    /(?:Address|Office)[\s:]+([A-Za-z0-9\s,.-]+?)(?:\n|$)/i,
    /([A-Z][a-z]+(?:,\s*[A-Z]{2})?)\s*(?:USA|United\s+States|U\.S\.|US)/,
    /([A-Z][a-z]+,\s*[A-Z][a-z]+)/, // City, Country
  ];
  
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match) {
      const location = match[1].trim();
      // Validate it looks like a location
      if (location.length > 3 && location.length < 100 && /[A-Za-z]/.test(location)) {
        return location;
      }
    }
  }
  
  return null;
}

function extractIndustry(result: ScrapeResult): string | null {
  const markdown = result.markdown || '';
  const content = markdown.toLowerCase();
  
  // Industry keywords mapping
  const industries = {
    'SaaS': ['saas', 'software as a service', 'cloud platform', 'subscription software'],
    'Fintech': ['fintech', 'financial technology', 'payments', 'banking technology'],
    'Healthcare': ['healthcare', 'medical', 'healthtech', 'digital health'],
    'E-commerce': ['ecommerce', 'e-commerce', 'online retail', 'marketplace'],
    'EdTech': ['edtech', 'education technology', 'learning platform', 'online education'],
    'AI/ML': ['artificial intelligence', 'machine learning', 'ai platform', 'ml platform'],
    'Cybersecurity': ['cybersecurity', 'security platform', 'data protection', 'infosec'],
    'MarTech': ['martech', 'marketing technology', 'marketing platform', 'advertising tech'],
    'InsurTech': ['insurtech', 'insurance technology', 'digital insurance'],
    'Real Estate': ['proptech', 'real estate', 'property technology'],
  };
  
  // Count keyword matches
  const matches: Record<string, number> = {};
  
  for (const [industry, keywords] of Object.entries(industries)) {
    let count = 0;
    for (const keyword of keywords) {
      if (content.includes(keyword)) {
        count++;
      }
    }
    if (count > 0) {
      matches[industry] = count;
    }
  }
  
  // Return the industry with most matches
  const sorted = Object.entries(matches).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    return sorted[0][0];
  }
  
  // Look for explicit industry mentions
  const industryMatch = markdown.match(/(?:Industry|Sector)[\s:]+([A-Za-z\s&-]+?)(?:\n|,|\.|$)/i);
  if (industryMatch) {
    return industryMatch[1].trim();
  }
  
  return null;
}