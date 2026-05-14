// src/custom-tools/research.ts
// Custom tool: firecrawl_research
// Chains: search → scrape top N results → structured markdown with citations.
//
// Design note: client.deepResearch() exists in @mendable/firecrawl-js but is cloud-only
// (returns 404 on self-hosted, same as firecrawl_interact removed in Sprint 1).
// This tool implements research manually via search → scrape chaining.

import { z } from 'zod';
import type { MCP, SessionData } from './types.js';
import { createClient } from './client.js';

interface ResearchSource {
  url: string;
  title: string;
  description: string;
  content: string;
  error?: string;
}

export async function scrapeUrl(
  client: ReturnType<typeof createClient>,
  url: string,
  title: string,
  description: string
): Promise<ResearchSource> {
  try {
    const result = await client.scrape(url, {
      formats: ['markdown'],
      onlyMainContent: true,
    } as any);

    const doc = result as {
      markdown?: string;
      metadata?: { title?: string; description?: string };
    };

    return {
      url,
      title: doc.metadata?.title ?? title,
      description: doc.metadata?.description ?? description,
      content: doc.markdown ?? '(no content extracted)',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, title, description, content: '', error: `Scrape failed: ${message}` };
  }
}

export function safeSlice(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  // Trim to last whitespace boundary to avoid splitting mid-word or mid-surrogate-pair
  const sliced = content.slice(0, maxLen).replace(/[\uD800-\uDBFF]$/, '');
  const lastSpace = sliced.lastIndexOf(' ');
  return (lastSpace > maxLen - 100 ? sliced.slice(0, lastSpace) : sliced) +
    '\n\n*(content truncated — use firecrawl_scrape on this URL for full content)*';
}

export function formatOutput(query: string, sources: ResearchSource[]): string {
  const successful = sources.filter(s => !s.error);
  const failed = sources.filter(s => s.error);

  const lines: string[] = [
    `# Research: ${query}`,
    '',
    `**Sources found:** ${sources.length} | **Successfully scraped:** ${successful.length}`,
    '',
  ];

  if (successful.length === 0) {
    lines.push('> No content could be scraped. The search returned results but all scrapes failed.');
    lines.push('');
  }

  successful.forEach((s, i) => {
    lines.push(`## Source ${i + 1}: ${s.title}`);
    lines.push(`**URL:** ${s.url}`);
    if (s.description) {
      lines.push(`**Summary:** ${s.description}`);
    }
    lines.push('');
    lines.push(safeSlice(s.content, 2000));
    lines.push('');
    lines.push(`*Citation: [${s.title}](${s.url})*`);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  if (failed.length > 0) {
    lines.push('## Failed Sources');
    failed.forEach(s => {
      lines.push(`- [${s.title}](${s.url}) — ${s.error}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

export function register(server: MCP): void {
  server.addTool({
    name: 'firecrawl_research',
    description: `
Research a topic by searching the web and scraping top results into a single cited document.

**How it works:** Calls search to find relevant pages, scrapes each result in parallel, then returns a structured markdown document with all source content and citation links.

**Best for:** Multi-source research where you need raw content from several pages before synthesising an answer or report.
**Not for:** Single-page extraction (use firecrawl_scrape). Full-site crawls (use firecrawl_crawl).

**Usage Example:**
\`\`\`json
{
  "name": "firecrawl_research",
  "arguments": {
    "query": "Hetzner AX42 dedicated server specs pricing 2025",
    "numResults": 5
  }
}
\`\`\`

**Returns:** Structured markdown — one section per source with title, URL, content excerpt, and citation link. Failed scrapes are listed separately and do not crash the tool.
`,
    parameters: z.object({
      query: z.string().min(1).describe('Research query to search for'),
      numResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Number of search results to scrape (default: 5, max: 10)'),
    }),
    execute: async (args, context) => {
      const { session } = context as { session?: SessionData };
      const { query, numResults } = args as { query: string; numResults?: number };
      const limit = numResults ?? 5;
      const client = createClient(session);

      // Step 1: Search for top results
      let webResults: Array<{ url: string; title?: string; description?: string }>;
      try {
        const searchData = (await client.search(query, {
          limit,
          sources: [{ type: 'web' }],
        } as any)) as { web?: Array<{ url: string; title?: string; description?: string }> };
        webResults = searchData.web ?? [];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `# Research: ${query}\n\n**Error:** Search failed — ${message}\n\nCheck that the Firecrawl instance is reachable.`;
      }

      if (webResults.length === 0) {
        return `# Research: ${query}\n\n**No results found.** Try a different query or check that the Firecrawl search endpoint is working.`;
      }

      // Step 2: Scrape all results in parallel (per-URL error isolation)
      // Filter out any results missing a valid URL before scraping
      const validResults = webResults
        .slice(0, limit)
        .filter(r => typeof r.url === 'string' && r.url.length > 0);

      const sources = await Promise.all(
        validResults.map(result =>
          scrapeUrl(client, result.url, result.title ?? result.url, result.description ?? '')
        )
      );

      // Step 3: Format and return structured markdown with citations
      return formatOutput(query, sources);
    },
  });
}
