// src/custom-tools/enrich.ts
// Custom tool: firecrawl_enrich
// Chains: search (company discovery) → scrape (profile extraction) → structured JSON with source attribution.

import { z } from 'zod';
import type { MCP, SessionData } from './types.js';
import { createClient } from './client.js';

interface EnrichResult {
  enrichment_status: 'full' | 'partial' | 'not_found';
  company: {
    name: string | null;
    website: string | null;
    description: string | null;
    industry: string | null;
    email_domain: string | null;
  };
  source: string | null;
  sources_searched: string[];
  error?: string;
}

export function buildSearchQuery(
  email?: string,
  companyName?: string
): { query: string; emailDomain: string | null } {
  // Use slice(-1)[0] to always take the last @-segment — handles sub-addressed and multi-@ emails
  const emailDomain = email ? (email.split('@').slice(-1)[0] ?? null) : null;

  if (companyName && emailDomain) {
    return { query: `${companyName} ${emailDomain} company website`, emailDomain };
  }
  if (companyName) {
    return { query: `${companyName} company website`, emailDomain };
  }
  if (emailDomain) {
    return { query: `${emailDomain} company about`, emailDomain };
  }
  return { query: '', emailDomain: null };
}

export function extractProfile(
  metadata: { title?: string; description?: string; url?: string } | undefined,
  content: string,
  emailDomain: string | null,
  sourceUrl: string
): EnrichResult['company'] {
  // Use || null so that an empty string after stripping title decorators returns null, not ""
  const name = metadata?.title?.replace(/\s*[-|].*$/, '').trim() || null;
  const description = metadata?.description ?? null;

  const industryKeywords: [RegExp, string][] = [
    [/\b(software|saas|tech|technology|platform|api)\b/i, 'Technology'],
    [/\b(marketing|advertising|agency|seo|brand)\b/i, 'Marketing'],
    [/\b(finance|fintech|banking|investment|payments)\b/i, 'Finance'],
    [/\b(health|healthcare|medical|pharma|wellness)\b/i, 'Healthcare'],
    [/\b(e-commerce|ecommerce|retail|shop|store)\b/i, 'Retail / E-Commerce'],
    [/\b(logistics|shipping|supply chain|freight)\b/i, 'Logistics'],
    [/\b(legal|law|attorney|compliance)\b/i, 'Legal'],
    [/\b(education|edtech|learning|university|school)\b/i, 'Education'],
    [/\b(real estate|property|realty)\b/i, 'Real Estate'],
  ];

  let industry: string | null = null;
  const combinedText = `${name ?? ''} ${description ?? ''} ${content.slice(0, 1000)}`;
  for (const [pattern, label] of industryKeywords) {
    if (pattern.test(combinedText)) {
      industry = label;
      break;
    }
  }

  return {
    name,
    website: metadata?.url ?? sourceUrl,
    description,
    industry,
    email_domain: emailDomain,
  };
}

export function register(server: MCP): void {
  server.addTool({
    name: 'firecrawl_enrich',
    description: `
Enrich a lead by discovering and scraping their company profile from the web.

**How it works:** Accepts an email address and/or company name → searches for the company website → scrapes the homepage → returns a structured JSON profile with industry, description, and source attribution.

**Best for:** Lead enrichment workflows where you have an email or company name and need company profile data.
**Not for:** Full-site crawls (use firecrawl_crawl). Multi-source research (use firecrawl_research).

**Usage Example:**
\`\`\`json
{
  "name": "firecrawl_enrich",
  "arguments": {
    "email": "john@acme.com",
    "companyName": "Acme Corp"
  }
}
\`\`\`

**Returns:** Structured JSON — enrichment_status, company profile (name, website, description, industry, email_domain), source URL scraped, and all URLs found in search.
`,
    parameters: z.object({
      email: z
        .string()
        .email()
        .optional()
        .describe('Email address to enrich (e.g. john@acme.com) — used to extract company domain'),
      companyName: z
        .string()
        .min(1)
        .optional()
        .describe('Company name to enrich (e.g. Acme Corp) — used as primary search term'),
    }),
    execute: async (args, context) => {
      const { session } = context as { session?: SessionData };
      const { email, companyName } = args as { email?: string; companyName?: string };

      // Validate: at least one input required
      if (!email && !companyName) {
        const result: EnrichResult = {
          enrichment_status: 'not_found',
          company: {
            name: null,
            website: null,
            description: null,
            industry: null,
            email_domain: null,
          },
          source: null,
          sources_searched: [],
          error: 'At least one of email or companyName must be provided.',
        };
        return JSON.stringify(result, null, 2);
      }

      const client = createClient(session);
      const { query, emailDomain } = buildSearchQuery(email, companyName);

      // Step 1: Search for company website
      let searchResults: Array<{ url: string; title?: string; description?: string }> = [];
      try {
        const searchData = (await client.search(query, {
          limit: 3,
          sources: [{ type: 'web' }],
        } as any)) as { web?: Array<{ url: string; title?: string; description?: string }> };
        searchResults = searchData.web ?? [];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const result: EnrichResult = {
          enrichment_status: 'not_found',
          company: {
            name: null,
            website: null,
            description: null,
            industry: null,
            email_domain: emailDomain,
          },
          source: null,
          sources_searched: [],
          error: `Search failed — ${message}`,
        };
        return JSON.stringify(result, null, 2);
      }

      if (searchResults.length === 0) {
        const result: EnrichResult = {
          enrichment_status: 'not_found',
          company: {
            name: null,
            website: null,
            description: null,
            industry: null,
            email_domain: emailDomain,
          },
          source: null,
          sources_searched: [],
          error: `No search results found for query: "${query}"`,
        };
        return JSON.stringify(result, null, 2);
      }

      const sourcesSearched = searchResults.map(r => r.url);
      const topResult = searchResults[0];

      // Step 2: Scrape top result for profile data
      let scraped: {
        markdown?: string;
        metadata?: { title?: string; description?: string; url?: string };
      };
      try {
        const raw = await client.scrape(topResult.url, {
          formats: ['markdown'],
          onlyMainContent: true,
        } as any);
        scraped = raw as typeof scraped;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Scrape failed — return partial enrichment using search result metadata
        const result: EnrichResult = {
          enrichment_status: 'partial',
          company: {
            name: topResult.title ?? null,
            website: topResult.url,
            description: topResult.description ?? null,
            industry: null,
            email_domain: emailDomain,
          },
          source: topResult.url,
          sources_searched: sourcesSearched,
          error: `Scrape failed (partial data from search metadata) — ${message}`,
        };
        return JSON.stringify(result, null, 2);
      }

      // Step 3: Extract profile and return
      const company = extractProfile(
        scraped.metadata,
        scraped.markdown ?? '',
        emailDomain,
        topResult.url
      );

      const hasData = company.name || company.description || company.industry;
      const result: EnrichResult = {
        enrichment_status: hasData ? 'full' : 'partial',
        company,
        source: topResult.url,
        sources_searched: sourcesSearched,
      };
      return JSON.stringify(result, null, 2);
    },
  });
}
