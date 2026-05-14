import { FirecrawlService } from '../services/firecrawl.js';
import { OpenAIService } from '../services/synthesis.js';
import { parseEmail, generateSearchQueriesFromEmail } from './email-parser.js';
import { findRelevantSnippet } from '../utils/source-context.js';
import type { CSVRow, EnrichmentField, EnrichmentResult, SearchResult } from '../types/index.js';
import type { LLMProvider } from '../llm/provider.js';

export interface EnrichmentStrategyOptions {
  firecrawlApiKey: string;
  /** OpenAI API key (legacy) — use llmProvider for new code */
  openaiApiKey?: string;
  llmProvider?: LLMProvider;
}

export class EnrichmentStrategy {
  private firecrawl: FirecrawlService;
  private openai: OpenAIService;

  constructor(options: EnrichmentStrategyOptions) {
    this.firecrawl = new FirecrawlService(options.firecrawlApiKey);
    if (options.llmProvider) {
      this.openai = new OpenAIService(options.llmProvider);
    } else if (options.openaiApiKey) {
      this.openai = new OpenAIService(options.openaiApiKey);
    } else {
      throw new Error('EnrichmentStrategy requires either llmProvider or openaiApiKey');
    }
  }

  async enrichRow(
    row: CSVRow,
    fields: EnrichmentField[]
  ): Promise<Record<string, EnrichmentResult>> {
    console.log(`[EnrichmentStrategy] Starting enrichment for row with fields: ${fields.map(f => f.name).join(', ')}`);
    const results: Record<string, EnrichmentResult> = {};

    // Parse email if available
    const emailField = Object.entries(row).find(([key]) => 
      key.toLowerCase().includes('email')
    );
    
    let searchQueries: string[] = [];
    let emailDomain: string | null = null;
    let isPersonalEmail = false;
    
    if (emailField && emailField[1]) {
      console.log(`[EnrichmentStrategy] Parsing email: ${emailField[1]}`);
      const parsedEmail = parseEmail(emailField[1]);
      if (parsedEmail) {
        searchQueries = generateSearchQueriesFromEmail(parsedEmail);
        emailDomain = parsedEmail.domain;
        console.log(`[EnrichmentStrategy] Parsed domain: ${emailDomain}, Generated ${searchQueries.length} search queries`);
        
        // Check if it's a personal email domain
        isPersonalEmail = !!(emailDomain && (
          emailDomain.includes('gmail.com') || 
          emailDomain.includes('yahoo.') || 
          emailDomain.includes('hotmail.') || 
          emailDomain.includes('outlook.') ||
          emailDomain.includes('aol.com') ||
          emailDomain.includes('icloud.com') ||
          emailDomain.includes('protonmail.com')
        ));
        
        // Add parsed info to context
        if (parsedEmail.companyName) {
          row._parsed_company = parsedEmail.companyName;
        }
        if (parsedEmail.firstName && parsedEmail.lastName) {
          row._parsed_name = `${parsedEmail.firstName} ${parsedEmail.lastName}`;
        }
        
        // Auto-generate website field if requested
        const websiteField = fields.find(f => 
          f.name === 'website' || 
          f.displayName.toLowerCase() === 'website' ||
          f.name === 'company_website'
        );
        
        if (websiteField && emailDomain && !emailDomain.includes('gmail.com') && !emailDomain.includes('yahoo.') && !emailDomain.includes('hotmail.') && !emailDomain.includes('outlook.')) {
          results[websiteField.name] = {
            field: websiteField.name,
            value: `https://${emailDomain}`,
            confidence: 0.9,
            source: 'Auto-generated from email domain'
          };
        }
      }
    }

    // If we have no search queries, try name-based search
    if (searchQueries.length === 0) {
      // Look for name fields in the row - prioritize _name from UI selection
      const nameField = row._name ? ['_name', row._name] : 
        Object.entries(row).find(([key]) => 
          key.toLowerCase() === 'name' || 
          key.toLowerCase() === 'full_name' ||
          key.toLowerCase() === 'fullname'
        );
      
      if (nameField && nameField[1]) {
        const fullName = nameField[1];
        console.log(`[EnrichmentStrategy] No company info from email, trying name-based search for: ${fullName}`);
        
        // Search for the person and their current company
        searchQueries = [
          `"${fullName}" current company`,
          `"${fullName}" CEO founder executive`,
          `"${fullName}" LinkedIn`
        ];
      } else if (emailDomain && !isPersonalEmail) {
        // Fall back to domain search only if not personal email
        searchQueries = [
          emailDomain,
          `site:${emailDomain}`,
          `"${emailDomain}" company about`
        ];
      }
    }
    
    let searchResults: SearchResult[] = [];
    
    if (emailDomain && !isPersonalEmail) {
      try {
        const websiteUrl = `https://${emailDomain}`;
        console.log(`[EnrichmentStrategy] Attempting direct scrape of ${websiteUrl}`);
        const directScrape = await this.firecrawl.scrapeUrl(websiteUrl);
        
        if (directScrape.data && directScrape.data.markdown) {
          console.log(`[EnrichmentStrategy] Direct scrape successful for ${emailDomain}, content length: ${directScrape.data.markdown.length}`);
          // Add the direct scrape as the first search result
          const scrapeData = directScrape.data as Record<string, unknown>;
          const metadata: SearchResult['metadata'] = {};
          // Only include string values in metadata
          if (scrapeData) {
            Object.entries(scrapeData).forEach(([key, value]) => {
              if (typeof value === 'string' && key !== 'markdown' && key !== 'html') {
                metadata[key] = value;
              }
            });
          }
          
          searchResults.push({
            url: websiteUrl,
            title: scrapeData?.title as string || `${emailDomain} - Official Website`,
            description: scrapeData?.description as string || '',
            markdown: directScrape.data.markdown,
            metadata
          });
        }
      } catch {
        console.log(`[EnrichmentStrategy] Direct domain scrape failed for ${emailDomain}, falling back to search`);
      }
    }
    
    // Then perform search for additional sources
    console.log(`[EnrichmentStrategy] Performing search with queries: ${searchQueries.slice(0, 3).join(', ')}`);
    const additionalResults = await this.performSearch(searchQueries.slice(0, 3), true);
    console.log(`[EnrichmentStrategy] Search returned ${additionalResults.length} results`);
    
    // Combine results, with company's own domain first
    searchResults = [...searchResults, ...additionalResults];
    console.log(`[EnrichmentStrategy] Total search results: ${searchResults.length}`);
    
    const enrichedData = await this.extractFromSearchResults(searchResults, fields, row);
    
    // Merge with pre-populated results (like website)
    Object.assign(results, enrichedData);
    
    const successfulFields = Object.entries(results).filter(([, r]) => r.value).map(([name]) => name);
    console.log(`[EnrichmentStrategy] Successfully enriched ${successfulFields.length} fields: ${successfulFields.join(', ')}`);

    return results;
  }

  private async performSearch(
    queries: string[],
    scrapeContent: boolean
  ): Promise<SearchResult[]> {
    if (queries.length === 0) return [];
    
    try {
      return await this.firecrawl.searchWithMultipleQueries(queries, {
        limit: 3,
        scrapeContent,
      });
    } catch {
      console.error('Search error occurred');
      return [];
    }
  }

  private async extractFromSearchResults(
    searchResults: SearchResult[],
    fields: EnrichmentField[],
    context: CSVRow
  ): Promise<Record<string, EnrichmentResult>> {
    if (searchResults.length === 0) {
      // Return empty values with low confidence when no search results
      const emptyResults: Record<string, EnrichmentResult> = {};
      fields.forEach(field => {
        emptyResults[field.name] = {
          field: field.name,
          value: '',
          confidence: 0,
          source: 'No search results found'
        };
      });
      return emptyResults;
    }

    // Combine content from all search results including metadata
    // Add target company notice to help LLM focus on the right company
    const targetCompany = context._parsed_company || context.company || 'the target company';
    const targetNotice = `\n[IMPORTANT: Extract information about "${targetCompany}" ONLY. Ignore data about other companies.]\n\n`;
    
    const combinedContent = targetNotice + searchResults
      .map(result => {
        let content = `URL: ${result.url}\n`;
        content += `Title: ${result.title}\n`;
        content += `Description: ${result.description}\n`;
        
        // Add metadata if available
        if (result.metadata) {
          content += `\nMetadata:\n`;
          if (result.metadata.title) content += `- Page Title: ${result.metadata.title}\n`;
          if (result.metadata.description) content += `- Meta Description: ${result.metadata.description}\n`;
          if (result.metadata.keywords) content += `- Keywords: ${result.metadata.keywords}\n`;
          if (result.metadata.ogTitle) content += `- OG Title: ${result.metadata.ogTitle}\n`;
          if (result.metadata.ogDescription) content += `- OG Description: ${result.metadata.ogDescription}\n`;
          if (result.metadata.author) content += `- Author: ${result.metadata.author}\n`;
          if (result.metadata.publishedDate) content += `- Published Date: ${result.metadata.publishedDate}\n`;
          // Add any other metadata fields
          Object.entries(result.metadata).forEach(([key, value]) => {
            if (!['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'author', 'publishedDate'].includes(key) && value) {
              content += `- ${key}: ${value}\n`;
            }
          });
        }
        
        if (result.markdown) {
          content += `\nContent:\n${result.markdown}\n`;
        }
        return content;
      })
      .join('\n---\n');

    try {
      const extracted = await this.openai.extractStructuredDataOriginal(
        combinedContent,
        fields,
        context
      );

      // Add source URLs and context to results
      Object.keys(extracted).forEach(fieldName => {
        if (extracted[fieldName]) {
          // Keep legacy source field for backward compatibility
          extracted[fieldName].source = searchResults
            .slice(0, 2)
            .map(r => r.url)
            .join(', ');
          
          // Check if LLM already provided source context
          if (extracted[fieldName].sourceContext && extracted[fieldName].sourceContext.length > 0) {
            // Validate the source context from LLM
            const llmSourceContext = extracted[fieldName].sourceContext;
            const validatedContext: typeof llmSourceContext = [];
            
            for (const ctx of llmSourceContext) {
              // Check if the URL is actually from our search results
              const matchingResult = searchResults.find(r => r.url === ctx.url);
              if (!matchingResult) {
                console.log(`[VALIDATION] LLM provided URL not in search results: ${ctx.url}`);
                continue;
              }
              
              // Verify the snippet actually exists in the content
              if (ctx.snippet && matchingResult.markdown) {
                const snippetExists = matchingResult.markdown.toLowerCase().includes(
                  ctx.snippet.toLowerCase().substring(0, 50)
                );
                if (!snippetExists) {
                  console.log(`[VALIDATION] LLM snippet not found in actual content for ${fieldName}`);
                  continue;
                }
              }
              
              validatedContext.push(ctx);
            }
            
            // If we have valid context from LLM, use it
            if (validatedContext.length > 0) {
              extracted[fieldName].sourceContext = validatedContext;
            } else if (extracted[fieldName].sourceContext[0]?.url === 'extracted') {
              // Handle legacy 'extracted' URL case
              const existingQuote = extracted[fieldName].sourceContext[0].snippet;
              const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
              const filteredResults = searchResults.filter(result => {
                try {
                  const domain = new URL(result.url).hostname.toLowerCase();
                  return !blockedDomains.some(blocked => domain.includes(blocked));
                } catch {
                  return true;
                }
              });
              
              // Find which source contains this quote
              const matchingSource = filteredResults.find(r => {
                const content = (r.markdown || r.description || '').toLowerCase();
                return content.includes(existingQuote.toLowerCase().substring(0, 50));
              });
              
              if (matchingSource) {
                extracted[fieldName].sourceContext = [{
                  url: matchingSource.url,
                  snippet: existingQuote
                }];
              } else if (filteredResults.length > 0) {
                // Use first available source with the quote
                extracted[fieldName].sourceContext = [{
                  url: filteredResults[0].url,
                  snippet: existingQuote
                }];
              }
            } else {
              // No valid context from LLM, fall back to finding snippets
              extracted[fieldName].sourceContext = undefined;
            }
          } else {
            // Fallback to finding snippets if LLM didn't provide them
            const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
            extracted[fieldName].sourceContext = searchResults
              .filter(result => {
                try {
                  const domain = new URL(result.url).hostname.toLowerCase();
                  return !blockedDomains.some(blocked => domain.includes(blocked));
                } catch {
                  return true;
                }
              })
              .map(result => {
                const snippet = findRelevantSnippet(
                  result.markdown || '', // Only use actual content, not description/title
                  extracted[fieldName].value,
                  fieldName
                );
                return {
                  url: result.url,
                  snippet
                };
              })
              .filter(ctx => ctx.snippet)
              .slice(0, 5);
          }
        }
      });

      return extracted;
    } catch (error) {
      console.error('Extraction error:', error);
      return {};
    }
  }
}