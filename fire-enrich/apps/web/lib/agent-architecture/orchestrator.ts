import { EmailContext, RowEnrichmentResult } from './core/types';
import { EnrichmentResult, SearchResult, EnrichmentField } from '../types';
import { parseEmail } from '../strategies/email-parser';
import { FirecrawlService } from '../services/firecrawl';
import { OpenAIService } from '../services/openai';

export class AgentOrchestrator {
  private firecrawl: FirecrawlService;
  private openai: OpenAIService;
  
  constructor(
    private firecrawlApiKey: string,
    private openaiApiKey: string
  ) {
    this.firecrawl = new FirecrawlService(firecrawlApiKey);
    this.openai = new OpenAIService(openaiApiKey);
  }
  
  async enrichRow(
    row: Record<string, string>,
    fields: EnrichmentField[],
    emailColumn: string,
    onProgress?: (field: string, value: unknown) => void,
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<RowEnrichmentResult> {
    const email = row[emailColumn];
    console.log(`[Orchestrator] Starting enrichment for email: ${email}`);
    
    interface OrchestrationContext extends Record<string, unknown> {
      email: string;
      emailContext: EmailContext;
      discoveredData: Record<string, unknown>;
      companyName?: string;
    }
    
    if (!email) {
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: 'No email found',
      };
    }
    
    try {
      // Step 1: Extract email context
      console.log(`[Orchestrator] Extracting email context from: ${email}`);
      const emailContext = this.extractEmailContext(email);
      console.log(`[Orchestrator] Email context: domain=${emailContext.domain}, company=${emailContext.companyNameGuess || 'unknown'}`);
      
      // Step 2: Categorize fields
      const fieldCategories = this.categorizeFields(fields);
      console.log(`[Orchestrator] Field categories: discovery=${fieldCategories.discovery.length}, profile=${fieldCategories.profile.length}, metrics=${fieldCategories.metrics.length}, funding=${fieldCategories.funding.length}, techStack=${fieldCategories.techStack.length}, other=${fieldCategories.other.length}`);
      
      // Log which agents will be used
      const agentsToUse = [];
      if (fieldCategories.discovery.length > 0) agentsToUse.push('discovery-agent');
      if (fieldCategories.profile.length > 0) agentsToUse.push('company-profile-agent');
      if (fieldCategories.metrics.length > 0) agentsToUse.push('metrics-agent');
      if (fieldCategories.funding.length > 0) agentsToUse.push('funding-agent');
      if (fieldCategories.techStack.length > 0) agentsToUse.push('tech-stack-agent');
      if (fieldCategories.other.length > 0) agentsToUse.push('general-agent');
      
      console.log(`[Orchestrator] Agents to be used: ${agentsToUse.join(', ')}`);
      console.log(`[Orchestrator] Agent execution order: ${agentsToUse.join(' → ')}`);
      
      // Send initial agent progress
      if (onAgentProgress) {
        onAgentProgress(`Planning enrichment strategy for ${emailContext.companyNameGuess || emailContext.domain}`, 'info');
        onAgentProgress(`Agent pipeline: ${agentsToUse.map(a => a.replace('-agent', '').replace('-', ' ')).join(' → ')}`, 'info');
      }
      
      // Step 3: Progressive enrichment
      const enrichments: Record<string, unknown> = {};
      const context: OrchestrationContext = { email, emailContext, discoveredData: {} };
      
      // Discovery phase (company identity)
      if (fieldCategories.discovery.length > 0) {
        console.log(`[Orchestrator] Activating DISCOVERY-AGENT for fields: ${fieldCategories.discovery.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`Discovery Agent: Identifying company from ${emailContext.domain}`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.discovery.map(f => f.name).join(', ')}`, 'info');
        }
        const discoveryResults = await this.runDiscoveryPhase(
          context,
          fieldCategories.discovery,
          onAgentProgress
        );
        console.log(`[Orchestrator] DISCOVERY-AGENT completed, found ${Object.keys(discoveryResults).length} values`);
        if (onAgentProgress && Object.keys(discoveryResults).length > 0) {
          onAgentProgress(`Discovery complete: Found ${Object.keys(discoveryResults).length} fields`, 'success');
        }
        Object.assign(enrichments, discoveryResults);
        Object.assign(context.discoveredData, discoveryResults);
        
        // If we found a company name, update the context
        const companyNameField = Object.keys(discoveryResults).find(key => 
          key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
        );
        if (companyNameField && discoveryResults[companyNameField]) {
          // Extract the value from the EnrichmentResult object
          const companyNameResult = discoveryResults[companyNameField] as { value?: unknown } | unknown;
          const companyNameValue = (companyNameResult && typeof companyNameResult === 'object' && 'value' in companyNameResult) ? companyNameResult.value : companyNameResult;
          (context as OrchestrationContext).companyName = companyNameValue as string;
          console.log(`[Orchestrator] Updated context with company name: ${(context as OrchestrationContext).companyName}`);
        }
        
        // Report progress
        for (const [field, value] of Object.entries(discoveryResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // Profile phase (industry, location, etc)
      if (fieldCategories.profile.length > 0) {
        console.log(`[Orchestrator] Activating COMPANY-PROFILE-AGENT for fields: ${fieldCategories.profile.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`Profile Agent: Gathering company details`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.profile.map(f => f.name).join(', ')}`, 'info');
        }
        const profileResults = await this.runProfilePhase(
          context,
          fieldCategories.profile,
          onAgentProgress
        );
        console.log(`[Orchestrator] COMPANY-PROFILE-AGENT completed, found ${Object.keys(profileResults).length} values`);
        if (onAgentProgress && Object.keys(profileResults).length > 0) {
          onAgentProgress(`Profile complete: Found ${Object.keys(profileResults).length} fields`, 'success');
        }
        Object.assign(enrichments, profileResults);
        
        for (const [field, value] of Object.entries(profileResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // Metrics phase (employee count, revenue)
      if (fieldCategories.metrics.length > 0) {
        console.log(`[Orchestrator] Activating METRICS-AGENT for fields: ${fieldCategories.metrics.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`Metrics Agent: Analyzing company metrics`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.metrics.map(f => f.name).join(', ')}`, 'info');
        }
        const metricsResults = await this.runMetricsPhase(
          context,
          fieldCategories.metrics,
          onAgentProgress
        );
        console.log(`[Orchestrator] METRICS-AGENT completed, found ${Object.keys(metricsResults).length} values`);
        if (onAgentProgress && Object.keys(metricsResults).length > 0) {
          onAgentProgress(`Metrics complete: Found ${Object.keys(metricsResults).length} fields`, 'success');
        }
        Object.assign(enrichments, metricsResults);
        
        for (const [field, value] of Object.entries(metricsResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // Funding phase
      if (fieldCategories.funding.length > 0) {
        console.log(`[Orchestrator] Activating FUNDING-AGENT for fields: ${fieldCategories.funding.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`Funding Agent: Researching investment data`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.funding.map(f => f.name).join(', ')}`, 'info');
        }
        const fundingResults = await this.runFundingPhase(
          context,
          fieldCategories.funding,
          onAgentProgress
        );
        console.log(`[Orchestrator] FUNDING-AGENT completed, found ${Object.keys(fundingResults).length} values`);
        if (onAgentProgress && Object.keys(fundingResults).length > 0) {
          onAgentProgress(`Funding complete: Found ${Object.keys(fundingResults).length} fields`, 'success');
        }
        Object.assign(enrichments, fundingResults);
        
        for (const [field, value] of Object.entries(fundingResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // Tech Stack phase
      if (fieldCategories.techStack.length > 0) {
        console.log(`[Orchestrator] Activating TECH-STACK-AGENT for fields: ${fieldCategories.techStack.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`Tech Stack Agent: Detecting technologies`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.techStack.map(f => f.name).join(', ')}`, 'info');
        }
        const techStackResults = await this.runTechStackPhase(
          context,
          fieldCategories.techStack,
          onAgentProgress
        );
        console.log(`[Orchestrator] TECH-STACK-AGENT completed, found ${Object.keys(techStackResults).length} values`);
        if (onAgentProgress && Object.keys(techStackResults).length > 0) {
          onAgentProgress(`Tech Stack complete: Found ${Object.keys(techStackResults).length} fields`, 'success');
        }
        Object.assign(enrichments, techStackResults);
        
        for (const [field, value] of Object.entries(techStackResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // General phase (CEO names, custom fields, etc)
      if (fieldCategories.other.length > 0) {
        console.log(`[Orchestrator] Activating GENERAL-AGENT for fields: ${fieldCategories.other.map(f => f.name).join(', ')}`);
        if (onAgentProgress) {
          onAgentProgress(`General Agent: Extracting custom information`, 'agent');
          onAgentProgress(`Target fields: ${fieldCategories.other.map(f => f.name).join(', ')}`, 'info');
        }
        const generalResults = await this.runGeneralPhase(
          context,
          fieldCategories.other,
          onAgentProgress
        );
        console.log(`[ORCHESTRATOR] GENERAL-AGENT completed, found ${Object.keys(generalResults).length} values`);
        if (onAgentProgress && Object.keys(generalResults).length > 0) {
          onAgentProgress(`General complete: Found ${Object.keys(generalResults).length} fields`, 'success');
        }
        Object.assign(enrichments, generalResults);
        
        for (const [field, value] of Object.entries(generalResults)) {
          if (value && onProgress) {
            onProgress(field, value);
          }
        }
      }
      
      // Convert to enrichment result format
      const enrichmentResults = this.formatEnrichmentResults(enrichments, fields);
      
      // Log final enrichment summary
      const enrichedFields = Object.entries(enrichmentResults).filter(([, r]) => r.value).map(([name]) => name);
      const missingFields = fields.filter(f => !enrichmentResults[f.name]?.value).map(f => f.name);
      
      console.log(`[Orchestrator] ====== ENRICHMENT SUMMARY ======`);
      console.log(`[Orchestrator] Email: ${email}`);
      console.log(`[Orchestrator] Successfully enriched: ${enrichedFields.length}/${fields.length} fields`);
      if (enrichedFields.length > 0) {
        console.log(`[Orchestrator] Enriched fields: ${enrichedFields.join(', ')}`);
      }
      if (missingFields.length > 0) {
        console.log(`[Orchestrator] Missing fields: ${missingFields.join(', ')}`);
      }
      console.log(`[Orchestrator] ================================`);
      
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: enrichmentResults,
        status: 'completed',
      };
    } catch (error) {
      console.error('Orchestrator error:', error);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  private extractEmailContext(email: string): EmailContext {
    const parsed = parseEmail(email);
    const [, domain] = email.split('@');
    
    const personalDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'];
    const isPersonalEmail = personalDomains.includes(domain.toLowerCase());
    
    return {
      email,
      domain,
      companyDomain: isPersonalEmail ? undefined : domain,
      personalName: parsed?.firstName && parsed?.lastName 
        ? `${parsed.firstName} ${parsed.lastName}` 
        : undefined,
      companyNameGuess: parsed?.companyName,
      isPersonalEmail,
    };
  }
  
  private categorizeFields(fields: EnrichmentField[]) {
    console.log(`[Orchestrator] Categorizing ${fields.length} fields for agent assignment...`);
    
    const categories = {
      discovery: [] as EnrichmentField[],
      profile: [] as EnrichmentField[],
      metrics: [] as EnrichmentField[],
      funding: [] as EnrichmentField[],
      techStack: [] as EnrichmentField[],
      other: [] as EnrichmentField[],
    };
    
    for (const field of fields) {
      const name = field.name.toLowerCase();
      const desc = field.description.toLowerCase();
      
      if (name.includes('company') && name.includes('name') || 
          name.includes('website') || 
          name.includes('description') && name.includes('company') ||
          desc.includes('company name') ||
          desc.includes('company description')) {
        categories.discovery.push(field);
      } else if (name.includes('industry') || 
                 name.includes('location') || 
                 name.includes('headquarter') ||
                 name.includes('founded')) {
        categories.profile.push(field);
      } else if (name.includes('employee') || 
                 name.includes('revenue') || 
                 name.includes('size')) {
        categories.metrics.push(field);
      } else if (name.includes('fund') || 
                 name.includes('invest') || 
                 name.includes('valuation')) {
        categories.funding.push(field);
      } else if (name.includes('tech') && name.includes('stack') || 
                 name.includes('technolog') || 
                 name.includes('framework') ||
                 name.includes('language') ||
                 name.includes('github') ||
                 desc.includes('tech stack') ||
                 desc.includes('programming') ||
                 desc.includes('technology')) {
        categories.techStack.push(field);
      } else {
        categories.other.push(field);
      }
    }
    
    return categories;
  }
  
  private async runDiscoveryPhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-DISCOVERY] Starting Discovery Phase');
    const ctxEmail = context['email'] as string;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    console.log(`[AGENT-DISCOVERY] Email: ${ctxEmail}`);
    console.log(`[AGENT-DISCOVERY] Domain: ${ctxEmailContext.domain}`);
    console.log(`[AGENT-DISCOVERY] Fields to discover: ${fields.map(f => f.name).join(', ')}`);
    
    const results: Record<string, unknown> = {};
    
    // Try direct website access first
    if (ctxEmailContext.companyDomain) {
      const websiteUrl = `https://${ctxEmailContext.companyDomain}`;
      console.log(`[AGENT-DISCOVERY] Attempting direct website scrape: ${websiteUrl}`);
      if (onAgentProgress) {
        onAgentProgress(`Attempting to access ${ctxEmailContext.companyDomain} directly...`, 'info');
      }
      try {
        const scraped = await this.firecrawl.scrapeUrl(websiteUrl);
        
        if (scraped.data && scraped.data.markdown && this.isValidCompanyWebsite({ markdown: scraped.data.markdown, metadata: scraped.data as Record<string, unknown> })) {
          console.log(`[AGENT-DISCOVERY] Website scrape successful, content length: ${scraped.data.markdown?.length || 0}`);
          if (onAgentProgress) {
            onAgentProgress(`Successfully accessed company website (${scraped.data.markdown?.length || 0} chars)`, 'success');
            onAgentProgress(`Extracting data from website content...`, 'info');
          }
          
          // Extract company name
          const companyNameField = fields.find(f => 
            f.name.toLowerCase().includes('company') && f.name.toLowerCase().includes('name')
          );
          if (companyNameField) {
            const companyName = this.extractCompanyName({ markdown: scraped.data.markdown, metadata: scraped.data as Record<string, unknown>, url: websiteUrl });
            if (companyName) {
              console.log(`[AGENT-DISCOVERY] Found company name: ${String(companyName)}`);
              if (onAgentProgress) {
                onAgentProgress(`Extracted company name: ${String(companyName)}`, 'success');
              }
              results[companyNameField.name] = {
                field: companyNameField.name,
                value: companyName,
                confidence: 0.9,
                source: websiteUrl,
                sourceContext: [{
                  url: websiteUrl,
                  snippet: `Found on company website`
                }]
              };
            }
          }
          
          // Extract website
          const websiteField = fields.find(f => f.name.toLowerCase().includes('website'));
          if (websiteField) {
            results[websiteField.name] = {
              field: websiteField.name,
              value: websiteUrl,
              confidence: 1.0,
              source: websiteUrl,
              sourceContext: [{
                url: websiteUrl,
                snippet: `Primary domain from direct access`
              }]
            };
          }
          
          // Extract description
          const descField = fields.find(f => 
            f.name.toLowerCase().includes('description') || 
            f.description.toLowerCase().includes('description')
          );
          if (descField) {
            const description = this.extractDescription({ markdown: scraped.data.markdown, metadata: scraped.data as Record<string, unknown> });
            if (description) {
              if (onAgentProgress) {
                onAgentProgress(`Extracted company description (${description.length} chars)`, 'success');
              }
              results[descField.name] = {
                field: descField.name,
                value: description,
                confidence: 0.85,
                source: websiteUrl,
                sourceContext: [{
                  url: websiteUrl,
                  snippet: description.substring(0, 200) + (description.length > 200 ? '...' : '')
                }]
              };
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`[AGENT-DISCOVERY] Direct website access failed: ${errorMessage}`);
        console.log('[AGENT-DISCOVERY] Activating fallback strategy...');
        if (onAgentProgress) {
          onAgentProgress(`Direct website access failed: ${errorMessage.substring(0, 100)}`, 'warning');
          onAgentProgress(`Activating search fallback strategy...`, 'info');
        }
      }
    } else {
      console.log('[AGENT-DISCOVERY] No company domain available, skipping direct scrape');
    }
    
    // If we still need fields, use search
    const missingFields = fields.filter(f => !results[f.name]);
    if (missingFields.length > 0) {
      console.log(`[AGENT-DISCOVERY] Missing fields after direct scrape: ${missingFields.map(f => f.name).join(', ')}`);
      console.log('[AGENT-DISCOVERY] Initiating search phase...');
      
      // Build search queries in order of priority
      const searchQueries = [];
      
      // 1. Try domain-based search first
      if (ctxEmailContext.companyDomain) {
        searchQueries.push(`"${ctxEmailContext.companyDomain}" company official website`);
        searchQueries.push(`site:${ctxEmailContext.companyDomain} about`);
      }
      
      // 2. Try company name guess from email
      if (ctxEmailContext.companyNameGuess) {
        searchQueries.push(`"${ctxEmailContext.companyNameGuess}" company official website`);
      }
      
      // 3. Try domain without TLD as company name
      if (ctxEmailContext.companyDomain) {
        const domainPart = ctxEmailContext.companyDomain.split('.')[0];
        searchQueries.push(`"${domainPart}" company website about`);
      }
      
      // 4. General search with email domain
      if (ctxEmailContext.domain) {
        searchQueries.push(`email domain ${ctxEmailContext.domain} company information`);
      }
      
      console.log(`[AGENT-DISCOVERY] Search queries to try: ${searchQueries.length}`);
      if (onAgentProgress) {
        onAgentProgress(`Prepared ${searchQueries.length} search queries for fallback`, 'info');
      }
      
      interface DiscoverySearchResult {
        url: string;
        title?: string;
        markdown?: string;
        content?: string;
      }
      
      let allSearchResults: DiscoverySearchResult[] = [];
      for (const query of searchQueries) {
        if (allSearchResults.length >= 5) break; // Limit total results
        
        try {
          console.log(`[AGENT-DISCOVERY] Searching: ${query}`);
          if (onAgentProgress) {
            onAgentProgress(`Search ${searchQueries.indexOf(query) + 1}/${searchQueries.length}: ${query.substring(0, 60)}...`, 'info');
          }
          const searchResults = await this.firecrawl.search(
            query,
            { limit: 3 }
          );
          
          if (searchResults && searchResults.length > 0) {
            console.log(`[AGENT-DISCOVERY] Found ${searchResults.length} results for query`);
            if (onAgentProgress) {
              onAgentProgress(`Found ${searchResults.length} search results`, 'success');
            }
            allSearchResults = allSearchResults.concat(searchResults as DiscoverySearchResult[]);
          }
        } catch (searchError) {
          console.log(`[AGENT-DISCOVERY] Search failed for query "${query}": ${searchError}`);
        }
      }
      
      // Deduplicate results by URL
      const uniqueResults = Array.from(
        new Map(allSearchResults.map(r => [r.url, r])).values()
      );
      
      console.log(`[AGENT-DISCOVERY] Total unique search results: ${uniqueResults.length}`);
      if (onAgentProgress && uniqueResults.length > 0) {
        onAgentProgress(`Processing ${uniqueResults.length} unique search results...`, 'info');
      }
      
      if (uniqueResults.length > 0) {
        // Filter out invalid results
        const validResults = uniqueResults.filter(result => {
          if (!result.markdown || result.markdown.length < 100) return false;
          
          // Check for domain parking indicators in search results
          const lowerContent = (result.markdown || '').toLowerCase();
          const lowerTitle = (result.title || '').toLowerCase();
          
          const parkingIndicators = [
            'domain for sale',
            'buy this domain',
            'make an offer',
            'domain parking',
            'checkout the full domain details'
          ];
          
          for (const indicator of parkingIndicators) {
            if (lowerContent.includes(indicator) || lowerTitle.includes(indicator)) {
              console.log(`[AGENT-DISCOVERY] Filtering out domain parking result: ${result.url}`);
              return false;
            }
          }
          
          return true;
        });
        
        console.log(`[AGENT-DISCOVERY] Valid search results after filtering: ${validResults.length}`);
        if (onAgentProgress) {
          onAgentProgress(`Filtered to ${validResults.length} valid results`, validResults.length > 0 ? 'success' : 'warning');
        }
        
        if (validResults.length > 0) {
          if (onAgentProgress) {
            onAgentProgress(`Extracting data from search results...`, 'info');
          }
          // Process search results to extract missing fields
          const extractedData = await this.extractFromSearchResults(
            validResults,
            missingFields,
            context,
            onAgentProgress
          );
          
          Object.assign(results, extractedData);
          if (onAgentProgress && Object.keys(extractedData).length > 0) {
            onAgentProgress(`Extracted ${Object.keys(extractedData).length} fields from search results`, 'success');
          }
        } else {
          console.log('[AGENT-DISCOVERY] No valid search results after filtering');
          if (onAgentProgress) {
            onAgentProgress(`No valid search results found`, 'warning');
          }
        }
      } else {
        console.log('[AGENT-DISCOVERY] No search results found, using domain-based fallback');
        if (onAgentProgress) {
          onAgentProgress(`No search results found, using domain-based inference`, 'warning');
        }
        // Last resort: use domain-based inference
        const fallbackData = this.inferFromDomain(ctxEmailContext, missingFields);
        Object.assign(results, fallbackData);
        if (onAgentProgress && Object.keys(fallbackData).length > 0) {
          onAgentProgress(`Inferred ${Object.keys(fallbackData).length} fields from domain`, 'info');
        }
      }
    }
    
    return results;
  }
  
  private async runProfilePhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-PROFILE] Starting Profile Phase');
    // Look for company name in discovered data or context
    const ctxDiscoveredData = context['discoveredData'] as Record<string, unknown>;
    const companyNameField = Object.keys(ctxDiscoveredData).find(key => 
      key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
    );
    const ctxCompanyName = context['companyName'] as string | undefined;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    const fieldValue = ctxDiscoveredData[companyNameField || ''] as { value?: unknown } | unknown;
    const companyName = ctxCompanyName || 
                       (companyNameField && fieldValue ? 
                         ((fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) ? fieldValue.value : fieldValue) : null) ||
                       ctxEmailContext?.companyNameGuess;
    
    console.log(`[AGENT-PROFILE] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-PROFILE] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    if (onAgentProgress) {
      onAgentProgress(`Using company name: ${companyName || 'Unknown'}`, 'info');
    }
    
    if (!companyName) {
      console.log('[AGENT-PROFILE] No company name available, skipping profile phase');
      return {};
    }
    
    // Search for profile information
    // Prioritize company's own domain if available
    const domainQuery = ctxEmailContext?.companyDomain 
      ? `site:${ctxEmailContext.companyDomain} OR ` 
      : '';
    const searchQuery = `${domainQuery}"${String(companyName)}" headquarters industry "founded in" "year founded" location "based in" about`;
    console.log(`[AGENT-PROFILE] Search query: ${searchQuery}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Search query: ${searchQuery.substring(0, 100)}...`, 'info');
      onAgentProgress(`Searching for profile information...`, 'info');
    }
    
    const searchResults = await this.firecrawl.search(searchQuery, { limit: 5, scrapeContent: true });
    
    console.log(`[AGENT-PROFILE] Found ${searchResults.length} search results`);
    
    if (onAgentProgress) {
      if (searchResults.length > 0) {
        onAgentProgress(`Found ${searchResults.length} sources with profile data`, 'success');
        onAgentProgress(`Starting corroborated extraction for fields: ${fields.map(f => f.name).join(', ')}`, 'info');
      } else {
        onAgentProgress(`No search results found for profile data`, 'warning');
      }
    }
    
    // Use OpenAI to extract structured data
    const targetCompanyNotice = `\n\n[IMPORTANT: You are looking for information about "${String(companyName)}" ONLY. Ignore information about other companies.]\n\n`;
    const trimmedResults = this.trimSearchResultsContent(searchResults, 250000); // Smaller limit for profile phase
    const combinedContent = targetCompanyNotice + trimmedResults;
    
    // Use corroboration method if available, otherwise fallback
    // Include domain info to help with company matching
    const enrichmentContext: Record<string, string> = {};
    if (companyName && typeof companyName === 'string') enrichmentContext.companyName = companyName;
    if (ctxEmailContext?.companyDomain) enrichmentContext.targetDomain = ctxEmailContext.companyDomain;
    
    const enrichmentResults = typeof this.openai.extractStructuredDataWithCorroboration === 'function'
      ? await this.openai.extractStructuredDataWithCorroboration(
          combinedContent,
          fields,
          enrichmentContext,
          onAgentProgress
        )
      : await this.openai.extractStructuredDataOriginal(
          combinedContent,
          fields,
          enrichmentContext
        );
    
    // Add source URLs to each result (only if not already present from corroboration)
    const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
      if (enrichment && enrichment.value) {
        // Filter out blocked domains
        const filteredResults = searchResults.filter(r => {
          try {
            const domain = new URL(r.url).hostname.toLowerCase();
            return !blockedDomains.some(blocked => domain.includes(blocked));
          } catch {
            return true;
          }
        });
        
        // Only add source if not already present
        if (!enrichment.source) {
          enrichment.source = filteredResults.slice(0, 2).map(r => r.url).join(', ');
        }
        // Update sourceContext with actual URLs
        if (enrichment.sourceContext && enrichment.sourceContext.length > 0) {
          // If we have source quotes from the LLM, keep them as-is if they have valid URLs
          const hasValidUrls = enrichment.sourceContext.some(ctx => ctx.url && ctx.url !== 'extracted');
          if (!hasValidUrls) {
            // Try to match the quote to actual sources
            const existingQuote = enrichment.sourceContext[0].snippet;
            if (existingQuote) {
              // Find which source contains this quote
              const matchingSource = filteredResults.find(r => {
                const content = (r.markdown || '').toLowerCase();
                return content.includes(existingQuote.toLowerCase().substring(0, 50));
              });
              
              if (matchingSource) {
                enrichment.sourceContext = [{
                  url: matchingSource.url,
                  snippet: existingQuote
                }];
              } else {
                // If we can't match, show the first valid source with the quote
                enrichment.sourceContext = filteredResults.slice(0, 1).map(r => ({
                  url: r.url,
                  snippet: existingQuote
                }));
              }
            }
          }
        } else {
          // Fallback to finding snippets if LLM didn't provide them
          const { findRelevantSnippet } = await import('../utils/source-context');
          console.log(`[SOURCE-CONTEXT] Using fallback snippet extraction for ${fieldName}`);
          
          enrichment.sourceContext = filteredResults.map(r => {
            const snippet = findRelevantSnippet(
              r.markdown || '',
              enrichment.value,
              fieldName
            );
            
            if (!snippet) {
              console.log(`[SOURCE-CONTEXT] No snippet found for ${fieldName} value "${enrichment.value}" in ${r.url}`);
            }
            
            return {
              url: r.url,
              snippet
            };
          }).filter(ctx => {
            const hasSnippet = ctx.snippet && ctx.snippet.length > 0;
            if (!hasSnippet) {
              console.log(`[SOURCE-CONTEXT] Filtering out empty snippet for ${fieldName} from ${ctx.url}`);
            }
            return hasSnippet;
          }).slice(0, 5);
          
          console.log(`[SOURCE-CONTEXT] Final source context for ${fieldName}: ${enrichment.sourceContext.length} sources`);
        }
      }
    }
    
    return enrichmentResults;
  }
  
  private async runMetricsPhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-METRICS] Starting Metrics Phase');
    // Look for company name in discovered data or context
    const ctxDiscoveredData = context['discoveredData'] as Record<string, unknown>;
    const companyNameField = Object.keys(ctxDiscoveredData).find(key => 
      key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
    );
    const ctxCompanyName = context['companyName'] as string | undefined;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    const fieldValue = ctxDiscoveredData[companyNameField || ''] as { value?: unknown } | unknown;
    const companyName = ctxCompanyName || 
                       (companyNameField && fieldValue ? 
                         ((fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) ? fieldValue.value : fieldValue) : null) ||
                       ctxEmailContext?.companyNameGuess;
    
    console.log(`[AGENT-METRICS] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-METRICS] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (!companyName) {
      console.log('[AGENT-METRICS] No company name available, skipping metrics phase');
      return {};
    }
    
    // Search for metrics
    const year = new Date().getFullYear();
    // Prioritize company's own domain if available
    const domainQuery = ctxEmailContext?.companyDomain 
      ? `site:${ctxEmailContext.companyDomain} OR ` 
      : '';
    // Use multiple search strategies for better coverage
    const searchQuery = `${domainQuery}"${String(companyName)}" employees "team size" revenue "annual revenue" ARR MRR ${year} ${year-1}`;
    console.log(`[AGENT-METRICS] Search query: ${searchQuery}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Searching for metrics data...`, 'info');
      onAgentProgress(`Query: ${searchQuery.substring(0, 100)}...`, 'info');
    }
    
    const searchResults = await this.firecrawl.search(searchQuery, { limit: 5, scrapeContent: true });
    
    console.log(`[AGENT-METRICS] Found ${searchResults.length} search results`);
    if (onAgentProgress) {
      onAgentProgress(`Found ${searchResults.length} sources with metrics data`, searchResults.length > 0 ? 'success' : 'warning');
    }
    
    // Extract metrics with OpenAI
    const combinedContent = this.trimSearchResultsContent(searchResults, 250000);
    
    if (onAgentProgress && searchResults.length > 0) {
      onAgentProgress(`Extracting metrics from ${searchResults.length} sources...`, 'info');
    }
    
    // Use corroboration method if available, otherwise fallback
    // Include domain info to help with company matching
    const enrichmentContext: Record<string, string> = {};
    if (companyName && typeof companyName === 'string') enrichmentContext.companyName = companyName;
    if (ctxEmailContext?.companyDomain) enrichmentContext.targetDomain = ctxEmailContext.companyDomain;
    
    const enrichmentResults = typeof this.openai.extractStructuredDataWithCorroboration === 'function'
      ? await this.openai.extractStructuredDataWithCorroboration(
          combinedContent,
          fields,
          enrichmentContext,
          onAgentProgress
        )
      : await this.openai.extractStructuredDataOriginal(
          combinedContent,
          fields,
          enrichmentContext
        );
    
    // Add source URLs to each result (only if not already present from corroboration)
    const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
      if (enrichment && enrichment.value) {
        // Filter out blocked domains
        const filteredResults = searchResults.filter(r => {
          try {
            const domain = new URL(r.url).hostname.toLowerCase();
            return !blockedDomains.some(blocked => domain.includes(blocked));
          } catch {
            return true;
          }
        });
        
        // Only add source if not already present
        if (!enrichment.source) {
          enrichment.source = filteredResults.slice(0, 2).map(r => r.url).join(', ');
        }
        // Update sourceContext with actual URLs
        if (enrichment.sourceContext && enrichment.sourceContext.length > 0) {
          // If we have source quotes from the LLM, keep them as-is if they have valid URLs
          const hasValidUrls = enrichment.sourceContext.some(ctx => ctx.url && ctx.url !== 'extracted');
          if (!hasValidUrls) {
            // Try to match the quote to actual sources
            const existingQuote = enrichment.sourceContext[0].snippet;
            if (existingQuote) {
              // Find which source contains this quote
              const matchingSource = filteredResults.find(r => {
                const content = (r.markdown || '').toLowerCase();
                return content.includes(existingQuote.toLowerCase().substring(0, 50));
              });
              
              if (matchingSource) {
                enrichment.sourceContext = [{
                  url: matchingSource.url,
                  snippet: existingQuote
                }];
              } else {
                // If we can't match, show the first valid source with the quote
                enrichment.sourceContext = filteredResults.slice(0, 1).map(r => ({
                  url: r.url,
                  snippet: existingQuote
                }));
              }
            }
          }
        } else {
          // Fallback to finding snippets if LLM didn't provide them
          const { findRelevantSnippet } = await import('../utils/source-context');
          console.log(`[SOURCE-CONTEXT] Using fallback snippet extraction for ${fieldName}`);
          
          enrichment.sourceContext = filteredResults.map(r => {
            const snippet = findRelevantSnippet(
              r.markdown || '',
              enrichment.value,
              fieldName
            );
            
            if (!snippet) {
              console.log(`[SOURCE-CONTEXT] No snippet found for ${fieldName} value "${enrichment.value}" in ${r.url}`);
            }
            
            return {
              url: r.url,
              snippet
            };
          }).filter(ctx => {
            const hasSnippet = ctx.snippet && ctx.snippet.length > 0;
            if (!hasSnippet) {
              console.log(`[SOURCE-CONTEXT] Filtering out empty snippet for ${fieldName} from ${ctx.url}`);
            }
            return hasSnippet;
          }).slice(0, 5);
          
          console.log(`[SOURCE-CONTEXT] Final source context for ${fieldName}: ${enrichment.sourceContext.length} sources`);
        }
      }
    }
    
    return enrichmentResults;
  }
  
  private async runFundingPhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-FUNDING] Starting Funding Phase');
    // Look for company name in discovered data or context
    const ctxDiscoveredData = context['discoveredData'] as Record<string, unknown>;
    const companyNameField = Object.keys(ctxDiscoveredData).find(key => 
      key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
    );
    const ctxCompanyName = context['companyName'] as string | undefined;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    const fieldValue = ctxDiscoveredData[companyNameField || ''] as { value?: unknown } | unknown;
    const companyName = ctxCompanyName || 
                       (companyNameField && fieldValue ? 
                         ((fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) ? fieldValue.value : fieldValue) : null) ||
                       ctxEmailContext?.companyNameGuess;
    
    console.log(`[AGENT-FUNDING] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-FUNDING] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (!companyName) {
      console.log('[AGENT-FUNDING] No company name available, skipping funding phase');
      return {};
    }
    
    // Search for funding information
    // Prioritize company's own domain if available
    const domainQuery = ctxEmailContext?.companyDomain 
      ? `site:${ctxEmailContext.companyDomain} OR ` 
      : '';
    const searchQuery = `${domainQuery}"${String(companyName)}" funding "raised" "series" investment "total funding" valuation investors`;
    console.log(`[AGENT-FUNDING] Search query: ${searchQuery}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Searching for funding information...`, 'info');
      onAgentProgress(`Query: ${searchQuery.substring(0, 100)}...`, 'info');
    }
    
    const searchResults = await this.firecrawl.search(searchQuery, { limit: 5, scrapeContent: true });
    
    console.log(`[AGENT-FUNDING] Found ${searchResults.length} search results`);
    if (onAgentProgress) {
      onAgentProgress(`Found ${searchResults.length} sources with funding data`, searchResults.length > 0 ? 'success' : 'warning');
    }
    
    // Extract funding data
    const combinedContent = this.trimSearchResultsContent(searchResults, 250000);
    
    if (onAgentProgress && searchResults.length > 0) {
      onAgentProgress(`Extracting funding data from sources...`, 'info');
    }
    
    // Use corroboration method if available, otherwise fallback
    // Include domain info to help with company matching
    const enrichmentContext: Record<string, string> = {};
    if (companyName && typeof companyName === 'string') enrichmentContext.companyName = companyName;
    if (ctxEmailContext?.companyDomain) enrichmentContext.targetDomain = ctxEmailContext.companyDomain;
    
    const enrichmentResults = typeof this.openai.extractStructuredDataWithCorroboration === 'function'
      ? await this.openai.extractStructuredDataWithCorroboration(
          combinedContent,
          fields,
          enrichmentContext,
          onAgentProgress
        )
      : await this.openai.extractStructuredDataOriginal(
          combinedContent,
          fields,
          enrichmentContext
        );
    
    // Add source URLs to each result (only if not already present from corroboration)
    const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
      if (enrichment && enrichment.value) {
        // Filter out blocked domains
        const filteredResults = searchResults.filter(r => {
          try {
            const domain = new URL(r.url).hostname.toLowerCase();
            return !blockedDomains.some(blocked => domain.includes(blocked));
          } catch {
            return true;
          }
        });
        
        // Only add source if not already present
        if (!enrichment.source) {
          enrichment.source = filteredResults.slice(0, 2).map(r => r.url).join(', ');
        }
        // Update sourceContext with actual URLs
        if (enrichment.sourceContext && enrichment.sourceContext.length > 0) {
          // If we have source quotes from the LLM, keep them as-is if they have valid URLs
          const hasValidUrls = enrichment.sourceContext.some(ctx => ctx.url && ctx.url !== 'extracted');
          if (!hasValidUrls) {
            // Try to match the quote to actual sources
            const existingQuote = enrichment.sourceContext[0].snippet;
            if (existingQuote) {
              // Find which source contains this quote
              const matchingSource = filteredResults.find(r => {
                const content = (r.markdown || '').toLowerCase();
                return content.includes(existingQuote.toLowerCase().substring(0, 50));
              });
              
              if (matchingSource) {
                enrichment.sourceContext = [{
                  url: matchingSource.url,
                  snippet: existingQuote
                }];
              } else {
                // If we can't match, show the first valid source with the quote
                enrichment.sourceContext = filteredResults.slice(0, 1).map(r => ({
                  url: r.url,
                  snippet: existingQuote
                }));
              }
            }
          }
        } else {
          // Fallback to finding snippets if LLM didn't provide them
          const { findRelevantSnippet } = await import('../utils/source-context');
          console.log(`[SOURCE-CONTEXT] Using fallback snippet extraction for ${fieldName}`);
          
          enrichment.sourceContext = filteredResults.map(r => {
            const snippet = findRelevantSnippet(
              r.markdown || '',
              enrichment.value,
              fieldName
            );
            
            if (!snippet) {
              console.log(`[SOURCE-CONTEXT] No snippet found for ${fieldName} value "${enrichment.value}" in ${r.url}`);
            }
            
            return {
              url: r.url,
              snippet
            };
          }).filter(ctx => {
            const hasSnippet = ctx.snippet && ctx.snippet.length > 0;
            if (!hasSnippet) {
              console.log(`[SOURCE-CONTEXT] Filtering out empty snippet for ${fieldName} from ${ctx.url}`);
            }
            return hasSnippet;
          }).slice(0, 5);
          
          console.log(`[SOURCE-CONTEXT] Final source context for ${fieldName}: ${enrichment.sourceContext.length} sources`);
        }
      }
    }
    
    return enrichmentResults;
  }
  
  private async runTechStackPhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-TECH-STACK] Starting Tech Stack Phase');
    // Look for company name in discovered data or context
    const ctxDiscoveredData = context['discoveredData'] as Record<string, unknown>;
    const companyNameField = Object.keys(ctxDiscoveredData).find(key => 
      key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
    );
    const ctxCompanyName = context['companyName'] as string | undefined;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    const fieldValue = ctxDiscoveredData[companyNameField || ''] as { value?: unknown } | unknown;
    const companyName = ctxCompanyName || 
                       (companyNameField && fieldValue ? 
                         ((fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) ? fieldValue.value : fieldValue) : null) ||
                       ctxEmailContext?.companyNameGuess;
    
    const companyDomain = ctxEmailContext?.companyDomain;
    
    console.log(`[AGENT-TECH-STACK] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-TECH-STACK] Company domain: ${companyDomain || 'Not found'}`);
    console.log(`[AGENT-TECH-STACK] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Using company: ${companyName || companyDomain || 'Unknown'}`, 'info');
    }
    
    if (!companyName && !companyDomain) {
      console.log('[AGENT-TECH-STACK] No company name or domain available, skipping tech stack phase');
      return {};
    }
    
    // Search for GitHub repositories
    const githubQuery = companyName && typeof companyName === 'string'
      ? `site:github.com "${companyName}" OR "${companyName.toLowerCase().replace(/\s+/g, '-')}"`
      : `site:github.com "${companyDomain?.replace('.com', '').replace('.io', '').replace('.ai', '')}"`;
    
    console.log(`[AGENT-TECH-STACK] GitHub search query: ${githubQuery}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Searching GitHub for repositories...`, 'info');
      onAgentProgress(`Query: ${githubQuery.substring(0, 80)}...`, 'info');
    }
    
    let githubResults: SearchResult[] = [];
    try {
      const searchResponse = await this.firecrawl.search(githubQuery, { 
        limit: 3,
        scrapeContent: true
      });
      
      // Validate that these are actual GitHub URLs
      githubResults = (searchResponse || []).filter(result => {
        if (!result || !result.url) return false;
        try {
          const url = new URL(result.url);
          return url.hostname === 'github.com' && url.pathname.includes('/');
        } catch {
          return false;
        }
      });
      
      console.log(`[AGENT-TECH-STACK] Found ${githubResults.length} valid GitHub results`);
      if (githubResults.length > 0) {
        console.log(`[AGENT-TECH-STACK] GitHub URLs: ${githubResults.map(r => r.url).join(', ')}`);
      }
    } catch (error) {
      console.log(`[AGENT-TECH-STACK] GitHub search failed: ${error}`);
      githubResults = [];
    }
    
    // Analyze HTML from company website for tech stack detection
    let websiteHtml = '';
    let detectedTechnologies: string[] = [];
    
    if (companyDomain) {
      try {
        console.log(`[AGENT-TECH-STACK] Fetching HTML from company website for analysis`);
        const websiteData = await this.firecrawl.scrapeUrl(`https://${companyDomain}`);
        if (websiteData.data && websiteData.data.html) {
          websiteHtml = websiteData.data.html;
          console.log(`[AGENT-TECH-STACK] HTML fetched, length: ${websiteHtml.length}`);
          
          // Analyze HTML for technology indicators
          detectedTechnologies = this.analyzeTechStackFromHtml(websiteHtml);
          console.log(`[AGENT-TECH-STACK] Detected technologies from HTML: ${detectedTechnologies.join(', ')}`);
        }
      } catch (error) {
        console.log(`[AGENT-TECH-STACK] Failed to fetch HTML: ${error}`);
      }
    }
    
    // Search for tech stack mentions
    const techSearchQuery = `"${companyName || companyDomain}" "tech stack" "built with" "powered by" technologies framework`;
    console.log(`[AGENT-TECH-STACK] Tech stack search query: ${techSearchQuery}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Searching for technology stack information...`, 'info');
    }
    
    const techResults = await this.firecrawl.search(techSearchQuery, { 
      limit: 3,
      scrapeContent: true
    });
    console.log(`[AGENT-TECH-STACK] Found ${techResults.length} tech stack results`);
    
    if (onAgentProgress) {
      onAgentProgress(`Found ${techResults.length} sources with tech stack data`, techResults.length > 0 ? 'success' : 'info');
    }
    
    // Combine all search results
    const allSearchResults = [...githubResults, ...techResults];
    
    // Create combined content including detected technologies
    let combinedContent = this.trimSearchResultsContent(allSearchResults, 200000); // Smaller limit for tech stack
    
    // Add detected technologies from HTML analysis
    if (detectedTechnologies.length > 0) {
      combinedContent = `DETECTED TECHNOLOGIES FROM HTML ANALYSIS:\n${detectedTechnologies.join(', ')}\n\n---\n\n` + combinedContent;
    }
    
    // Validate we have actual content before extraction
    const hasValidGithubContent = githubResults.length > 0 && 
      githubResults.some(r => r.markdown && r.markdown.length > 100);
    
    const hasValidTechContent = techResults.length > 0 && 
      techResults.some(r => r.markdown && r.markdown.length > 100);
    
    // If we don't have good search results and no detected technologies, use minimal approach
    if (!hasValidGithubContent && !hasValidTechContent && detectedTechnologies.length === 0) {
      console.log('[AGENT-TECH-STACK] No valid tech stack information found, returning empty results');
      return {};
    }
    
    // Extract structured data
    const enrichmentContext: Record<string, string> = {};
    if (companyName && typeof companyName === 'string') enrichmentContext.companyName = companyName;
    if (companyDomain) {
      enrichmentContext.companyDomain = companyDomain;
      enrichmentContext.targetDomain = companyDomain;
    }
    enrichmentContext.instruction = `CRITICAL: Only extract technology information that is EXPLICITLY mentioned in the provided content.
      
      DO NOT hallucinate or infer technologies.
      DO NOT make up GitHub URLs - only use URLs that actually appear in the search results.
      
      For tech stack fields:
      - Only include technologies that are explicitly mentioned
      - If HTML analysis detected technologies, you can include those
      - Do not guess based on company type or industry
      - If no tech stack information is found, return null
      
      Detected technologies from HTML (if any): ${detectedTechnologies.length > 0 ? detectedTechnologies.join(', ') : 'None'}
      
      Valid GitHub URLs found (if any): ${githubResults.map(r => r.url).join(', ') || 'None'}`;
    if (detectedTechnologies.length > 0) {
      enrichmentContext.detectedTechnologies = detectedTechnologies.join(', ');
    }
    if (githubResults.length > 0) {
      enrichmentContext.validGithubUrls = githubResults.map(r => r.url).join(', ');
    }
    
    const enrichmentResults = typeof this.openai.extractStructuredDataWithCorroboration === 'function'
      ? await this.openai.extractStructuredDataWithCorroboration(
          combinedContent,
          fields,
          enrichmentContext,
          onAgentProgress
        )
      : await this.openai.extractStructuredDataOriginal(
          combinedContent,
          fields,
          enrichmentContext
        );
    
    
    // Add source URLs to results and validate GitHub sources
    const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
      if (enrichment && enrichment.value) {
        // Filter out blocked domains
        const filteredResults = allSearchResults.filter(r => {
          try {
            const domain = new URL(r.url).hostname.toLowerCase();
            return !blockedDomains.some(blocked => domain.includes(blocked));
          } catch {
            return true;
          }
        });
        
        // Validate GitHub sources in the enrichment
        if (enrichment.sourceContext && Array.isArray(enrichment.sourceContext)) {
          enrichment.sourceContext = enrichment.sourceContext.filter(ctx => {
            if (!ctx.url) return false;
            
            // If it claims to be a GitHub URL, verify it was in our search results
            if (ctx.url.includes('github.com')) {
              const isValidGithub = githubResults.some(r => r.url === ctx.url);
              if (!isValidGithub) {
                console.log(`[AGENT-TECH-STACK] Removing hallucinated GitHub URL: ${ctx.url}`);
                return false;
              }
            }
            return true;
          });
        }
        
        // Only add source if not already present
        if (!enrichment.source) {
          enrichment.source = filteredResults.slice(0, 2).map(r => r.url).join(', ');
        }
        
        // Additional validation for tech stack values
        const field = fields.find(f => f.name === fieldName);
        if (field && field.type === 'array' && Array.isArray(enrichment.value)) {
          // Remove generic or unlikely technologies
          const genericTechs = ['website', 'web', 'internet', 'computer', 'software', 'technology', 'platform'];
          enrichment.value = enrichment.value.filter(tech => {
            const techLower = String(tech).toLowerCase();
            return !genericTechs.includes(techLower) && techLower.length > 1;
          });
          
          // If no valid technologies remain, keep empty array
          // (enrichment.value is already an empty array at this point)
        }
      }
    }
    
    return enrichmentResults;
  }
  
  private async runGeneralPhase(
    context: Record<string, unknown>,
    fields: EnrichmentField[],
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-GENERAL] Starting General Information Phase');
    // Look for company name in discovered data or context
    const ctxDiscoveredData = context['discoveredData'] as Record<string, unknown>;
    const companyNameField = Object.keys(ctxDiscoveredData).find(key => 
      key.toLowerCase().includes('company') && key.toLowerCase().includes('name')
    );
    const ctxCompanyName = context['companyName'] as string | undefined;
    const ctxEmailContext = context['emailContext'] as EmailContext;
    const fieldValue = ctxDiscoveredData[companyNameField || ''] as { value?: unknown } | unknown;
    const companyName = ctxCompanyName || 
                       (companyNameField && fieldValue ? 
                         ((fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) ? fieldValue.value : fieldValue) : null) ||
                       ctxEmailContext?.companyNameGuess;
    
    const companyDomain = ctxEmailContext?.companyDomain;
    
    console.log(`[AGENT-GENERAL] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Company domain: ${companyDomain || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);
    
    if (onAgentProgress) {
      onAgentProgress(`Using company: ${companyName || companyDomain || 'Unknown'}`, 'info');
    }
    
    if (!companyName && !companyDomain) {
      console.log('[AGENT-GENERAL] No company name or domain available, skipping general phase');
      return {};
    }
    
    // Build targeted search queries for the requested fields
    const searchQueries = this.buildGeneralSearchQueries(fields, typeof companyName === 'string' ? companyName : undefined, companyDomain);
    
    if (onAgentProgress && searchQueries.length > 0) {
      onAgentProgress(`Prepared ${searchQueries.length} search queries for custom fields`, 'info');
    }
    
    let allSearchResults: SearchResult[] = [];
    
    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      try {
        console.log(`[AGENT-GENERAL] Searching: ${query}`);
        if (onAgentProgress) {
          onAgentProgress(`Search ${i + 1}/${searchQueries.length}: ${query.substring(0, 60)}...`, 'info');
        }
        const searchResults = await this.firecrawl.search(query, { limit: 3, scrapeContent: true });
        
        if (searchResults && searchResults.length > 0) {
          console.log(`[AGENT-GENERAL] Found ${searchResults.length} results`);
          if (onAgentProgress) {
            onAgentProgress(`Found ${searchResults.length} results`, 'success');
          }
          allSearchResults = allSearchResults.concat(searchResults);
        }
      } catch (error) {
        console.log(`[AGENT-GENERAL] Search failed: ${error}`);
      }
    }
    
    // Also try to scrape specific pages for executive info
    if (companyDomain && this.hasExecutiveFields(fields)) {
      if (onAgentProgress) {
        onAgentProgress(`Checking company website for executive information...`, 'info');
      }
      
      const executiveUrls = [
        `https://${companyDomain}/about`,
        `https://${companyDomain}/team`,
        `https://${companyDomain}/leadership`,
        `https://${companyDomain}/about-us`,
        `https://${companyDomain}/our-team`
      ];
      
      for (let i = 0; i < executiveUrls.length; i++) {
        const url = executiveUrls[i];
        try {
          if (onAgentProgress) {
            onAgentProgress(`Checking ${url.split('/').pop()} page...`, 'info');
          }
          const scraped = await this.firecrawl.scrapeUrl(url);
          if (scraped.data && scraped.data.markdown) {
            allSearchResults.push({
              url,
              title: 'Company Leadership Page',
              description: 'Company leadership and team information',
              markdown: scraped.data.markdown || ''
            });
            console.log(`[AGENT-GENERAL] Successfully scraped ${url}`);
            if (onAgentProgress) {
              onAgentProgress(`Found executive information on ${url.split('/').pop()} page`, 'success');
            }
            break; // Stop after first successful scrape
          }
        } catch {
          // Continue to next URL
        }
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
    
    // Use trimmed content for extraction
    const combinedContent = this.trimSearchResultsContent(uniqueResults, 200000);
    
    // Extract structured data
    const enrichmentContext: Record<string, string> = {};
    if (companyName && typeof companyName === 'string') enrichmentContext.companyName = companyName;
    if (companyDomain) {
      enrichmentContext.companyDomain = companyDomain;
      enrichmentContext.targetDomain = companyDomain;
    }
    enrichmentContext.instruction = `Extract the requested information about ${companyName || companyDomain}.
      
      For executive names (CEO, CTO, CFO, etc.):
      - Look for mentions like "CEO", "Chief Executive Officer", "founder and CEO", etc.
      - Extract the person's full name
      - Be careful to match the title exactly as requested
      
      For other custom fields:
      - Extract exactly what is asked for
      - Only include information that is explicitly stated
      - Do not make assumptions or inferences`;
    
    const enrichmentResults = typeof this.openai.extractStructuredDataWithCorroboration === 'function'
      ? await this.openai.extractStructuredDataWithCorroboration(
          combinedContent,
          fields,
          enrichmentContext,
          onAgentProgress
        )
      : await this.openai.extractStructuredDataOriginal(
          combinedContent,
          fields,
          enrichmentContext
        );
    
    const foundFields = Object.keys(enrichmentResults).filter(k => enrichmentResults[k]?.value);
    if (onAgentProgress && foundFields.length > 0) {
      onAgentProgress(`Successfully extracted ${foundFields.length} custom fields`, 'success');
    }
    
    // Add source URLs to results
    const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
    for (const [, enrichment] of Object.entries(enrichmentResults)) {
      if (enrichment && enrichment.value) {
        // Filter out blocked domains
        const filteredResults = uniqueResults.filter(r => {
          try {
            const domain = new URL(r.url).hostname.toLowerCase();
            return !blockedDomains.some(blocked => domain.includes(blocked));
          } catch {
            return true;
          }
        });
        
        // Only add source if not already present
        if (!enrichment.source) {
          enrichment.source = filteredResults.slice(0, 2).map(r => r.url).join(', ');
        }
      }
    }
    
    return enrichmentResults;
  }
  
  private buildGeneralSearchQueries(fields: EnrichmentField[], companyName?: string, companyDomain?: string): string[] {
    const queries: string[] = [];
    
    // Group fields by type
    const executiveFields = fields.filter(f => this.isExecutiveField(f));
    const otherFields = fields.filter(f => !this.isExecutiveField(f));
    
    // Build queries for executive fields
    if (executiveFields.length > 0) {
      const titles = executiveFields.map(f => this.extractTitle(f)).filter(Boolean);
      
      if (companyName) {
        queries.push(`"${String(companyName)}" leadership team executives ${titles.join(' ')}`);
        queries.push(`"${String(companyName)}" CEO CTO CFO founders management`);
      }
      
      if (companyDomain) {
        queries.push(`site:${companyDomain} team leadership about executives`);
      }
    }
    
    // Build queries for other fields
    for (const field of otherFields) {
      const fieldTerms = this.getSearchTermsForField(field);
      
      if (companyName) {
        queries.push(`"${String(companyName)}" ${fieldTerms}`);
      }
      
      if (companyDomain) {
        queries.push(`site:${companyDomain} ${fieldTerms}`);
      }
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
  
  private analyzeTechStackFromHtml(html: string): string[] {
    const technologies: Set<string> = new Set();
    
    // Meta tag patterns
    const metaPatterns = [
      // Generator meta tags
      /<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/gi,
      /<meta\s+content=["']([^"']+)["']\s+name=["']generator["']/gi,
      
      // Application name
      /<meta\s+name=["']application-name["']\s+content=["']([^"']+)["']/gi,
      /<meta\s+content=["']([^"']+)["']\s+name=["']application-name["']/gi,
    ];
    
    // Script source patterns that indicate technologies
    const scriptPatterns = [
      // React
      /react(?:\.min)?\.js/i,
      /react-dom(?:\.min)?\.js/i,
      
      // Angular
      /angular(?:\.min)?\.js/i,
      /zone\.js/i,
      
      // Vue
      /vue(?:\.min)?\.js/i,
      
      // jQuery
      /jquery(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js/i,
      
      // Analytics
      /google-analytics\.com|googletagmanager\.com/i,
      /segment\.com|segment\.io/i,
      /hotjar\.com/i,
      /mixpanel\.com/i,
      
      // CDNs and frameworks
      /bootstrap(?:\.min)?\.(?:js|css)/i,
      /tailwind(?:css)?/i,
      /material(?:ize)?(?:\.min)?\.(?:js|css)/i,
      
      // Webpack/bundlers
      /webpack/i,
      /bundle\.\w+\.js/i,
      
      // Next.js
      /_next\/static/i,
      
      // Gatsby
      /gatsby/i,
    ];
    
    // Check meta tags
    for (const pattern of metaPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        if (match[1]) {
          technologies.add(match[1]);
        }
      }
    }
    
    // Check for framework-specific patterns in HTML
    if (html.includes('ng-app') || html.includes('ng-controller')) {
      technologies.add('AngularJS');
    }
    if (html.includes('v-for') || html.includes('v-if') || html.includes('v-model')) {
      technologies.add('Vue.js');
    }
    if (html.includes('data-react') || html.includes('__NEXT_DATA__')) {
      technologies.add('React');
    }
    if (html.includes('__NEXT_DATA__')) {
      technologies.add('Next.js');
    }
    if (html.includes('__NUXT__')) {
      technologies.add('Nuxt.js');
    }
    if (html.includes('gatsby-')) {
      technologies.add('Gatsby');
    }
    
    // Check script sources
    const scriptSrcMatches = html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi);
    for (const match of scriptSrcMatches) {
      const src = match[1];
      
      // Check against patterns
      for (const pattern of scriptPatterns) {
        if (pattern.test(src)) {
          // Extract technology name from pattern
          const techName = pattern.source
            .replace(/[\\^$.*+?()[\]{}|]/g, '')
            .replace(/\(\?:-?\d\+\\\.\d\+\\\.\d\+\)/g, '')
            .replace(/\(\?:\\.min\)/g, '')
            .replace(/\\\./g, '.')
            .replace(/\//g, '')
            .split(/[.-]/)[0];
          
          if (techName && techName.length > 2) {
            technologies.add(techName.charAt(0).toUpperCase() + techName.slice(1));
          }
        }
      }
      
      // Specific technology detection
      if (src.includes('react')) technologies.add('React');
      if (src.includes('angular')) technologies.add('Angular');
      if (src.includes('vue')) technologies.add('Vue.js');
      if (src.includes('jquery')) technologies.add('jQuery');
      if (src.includes('bootstrap')) technologies.add('Bootstrap');
      if (src.includes('tailwind')) technologies.add('Tailwind CSS');
      if (src.includes('wordpress')) technologies.add('WordPress');
      if (src.includes('shopify')) technologies.add('Shopify');
      if (src.includes('squarespace')) technologies.add('Squarespace');
      if (src.includes('wix')) technologies.add('Wix');
      if (src.includes('webflow')) technologies.add('Webflow');
      if (src.includes('stripe')) technologies.add('Stripe');
      if (src.includes('cloudflare')) technologies.add('Cloudflare');
      if (src.includes('cdn.jsdelivr.net')) technologies.add('jsDelivr CDN');
      if (src.includes('unpkg.com')) technologies.add('unpkg CDN');
      if (src.includes('cdnjs.cloudflare.com')) technologies.add('cdnjs');
    }
    
    // Check for CSS frameworks in link tags
    const linkMatches = html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi);
    for (const match of linkMatches) {
      const href = match[1];
      if (href.includes('bootstrap')) technologies.add('Bootstrap');
      if (href.includes('tailwind')) technologies.add('Tailwind CSS');
      if (href.includes('material')) technologies.add('Material Design');
      if (href.includes('bulma')) technologies.add('Bulma');
      if (href.includes('foundation')) technologies.add('Foundation');
      if (href.includes('semantic')) technologies.add('Semantic UI');
    }
    
    // Check for specific technology indicators in HTML comments
    const commentRegex = /<!--\s*([\s\S]+?)\s*-->/g;
    let commentMatch;
    while ((commentMatch = commentRegex.exec(html)) !== null) {
      const comment = commentMatch[1].toLowerCase();
      if (comment.includes('wordpress')) technologies.add('WordPress');
      if (comment.includes('drupal')) technologies.add('Drupal');
      if (comment.includes('joomla')) technologies.add('Joomla');
      if (comment.includes('magento')) technologies.add('Magento');
      if (comment.includes('shopify')) technologies.add('Shopify');
    }
    
    // Check for framework-specific CSS classes
    if (html.match(/class=["'][^"']*\bmui-[^"'\s]+/)) technologies.add('Material-UI');
    if (html.match(/class=["'][^"']*\bant-[^"'\s]+/)) technologies.add('Ant Design');
    if (html.match(/class=["'][^"']*\bchakra-[^"'\s]+/)) technologies.add('Chakra UI');
    
    // Check for specific meta properties
    if (html.includes('property="og:')) technologies.add('Open Graph Protocol');
    if (html.includes('name="twitter:')) technologies.add('Twitter Cards');
    
    // Check for PWA indicators
    if (html.includes('manifest.json') || html.includes('service-worker')) {
      technologies.add('Progressive Web App (PWA)');
    }
    
    // Remove duplicates and return as array
    return Array.from(technologies).filter(tech => tech && tech.length > 0);
  }
  
  private formatEnrichmentResults(
    enrichments: Record<string, unknown>,
    fields: EnrichmentField[]
  ): Record<string, EnrichmentResult> {
    const formatted: Record<string, EnrichmentResult> = {};
    
    for (const field of fields) {
      const enrichment = enrichments[field.name];
      
      // If we have a full EnrichmentResult object, use it
      if (enrichment && typeof enrichment === 'object' && 'value' in enrichment && 'confidence' in enrichment) {
        formatted[field.name] = enrichment as EnrichmentResult;
      } 
      // If we only have a raw value (shouldn't happen anymore, but keep as safety)
      else if (enrichment !== undefined && enrichment !== null) {
        console.warn(`[ORCHESTRATOR] Raw value found for field ${field.name}, this shouldn't happen`);
        // Ensure the value is of a valid type
        let value: string | number | boolean | string[];
        if (typeof enrichment === 'string' || typeof enrichment === 'number' || typeof enrichment === 'boolean') {
          value = enrichment;
        } else if (Array.isArray(enrichment)) {
          value = enrichment.map(item => String(item));
        } else {
          value = String(enrichment);
        }
        formatted[field.name] = {
          field: field.name,
          value,
          confidence: 0.5,
          source: 'Unknown source',
          sourceContext: []
        };
      }
      // If no data found, don't include in results
      else {
        // Don't add null results - let the UI handle missing fields
      }
    }
    
    return formatted;
  }
  
  private isValidCompanyWebsite(scraped: { markdown?: string; metadata?: { title?: string } }): boolean {
    const markdown = (scraped.markdown || '').toLowerCase();
    const title = (scraped.metadata?.title || '').toLowerCase();
    
    // Check for domain sale/parking indicators
    const invalidIndicators = [
      'domain for sale',
      'domain is for sale',
      'buy this domain',
      'purchase this domain',
      'make an offer',
      'domain parking',
      'parked domain',
      'under construction',
      'coming soon',
      'website is under construction',
      'this site is currently unavailable',
      'account suspended',
      'default web page',
      'test page',
      'apache2 ubuntu default',
      'welcome to nginx',
      'it works!',
      'index of /',
      'domain name registration',
      'get your domain',
      'register domain',
      'godaddy',
      'namecheap',
      'domain.com',
      '404 not found',
      '403 forbidden',
      'access denied'
    ];
    
    for (const indicator of invalidIndicators) {
      if (markdown.includes(indicator) || title.includes(indicator)) {
        console.log(`[ORCHESTRATOR] Detected invalid website indicator: "${indicator}"`);
        return false;
      }
    }
    
    // Check if content is too short (likely a placeholder)
    if (markdown.length < 200) {
      console.log(`[ORCHESTRATOR] Content too short (${markdown.length} chars), likely placeholder`);
      return false;
    }
    
    // Check for minimum legitimate content indicators
    const hasLegitimateContent = 
      markdown.includes('about') ||
      markdown.includes('product') ||
      markdown.includes('service') ||
      markdown.includes('contact') ||
      markdown.includes('team') ||
      markdown.includes('company') ||
      markdown.includes('we ') ||
      markdown.includes('our ');
    
    if (!hasLegitimateContent) {
      console.log(`[ORCHESTRATOR] No legitimate company content indicators found`);
      return false;
    }
    
    return true;
  }

  private extractCompanyName(scraped: { markdown?: string; metadata?: Record<string, unknown>; url?: string }): string | null {
    // First check if this is a valid company website
    if (!this.isValidCompanyWebsite(scraped)) {
      console.log('[ORCHESTRATOR] Invalid company website detected, skipping extraction');
      return null;
    }
    
    const metadata = scraped.metadata || {};
    const markdown = scraped.markdown || '';
    const url = scraped.url || '';
    
    // Extract domain from URL for validation
    const urlDomain = url.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    const baseDomain = urlDomain.replace(/^www\./, '').split('.')[0];
    
    console.log(`[ORCHESTRATOR] Extracting company name for domain: ${urlDomain}`);
    
    // Known company mappings for proper capitalization
    const knownCompanies: Record<string, string> = {
      'onetrust': 'OneTrust',
      'sideguide': 'Sideguide',
      'frontapp': 'Front',
      'shippo': 'Shippo',
      'lattice': 'Lattice',
      'pilot': 'Pilot',
      'fundera': 'Fundera',
      'flexport': 'Flexport',
      'triplebyte': 'Triplebyte',
      'zola': 'Zola',
      'pinterest': 'Pinterest',
      'brex': 'Brex',
      'deel': 'Deel',
      'scale': 'Scale AI',
      'wiz': 'Wiz',
      'firecrawl': 'Firecrawl',
    };
    
    // Check if it's a known company first
    if (knownCompanies[baseDomain]) {
      console.log(`[ORCHESTRATOR] Found known company: ${knownCompanies[baseDomain]}`);
      return knownCompanies[baseDomain];
    }
    
    // Look for og:site_name meta tag first (most reliable)
    const ogSiteNameMatch = markdown.match(/property="og:site_name"\s+content="([^"]+)"/i);
    if (ogSiteNameMatch && ogSiteNameMatch[1]) {
      const siteName = ogSiteNameMatch[1].trim();
      if (siteName && siteName.length > 2) {
        console.log(`[ORCHESTRATOR] Found company name in og:site_name: ${siteName}`);
        return siteName;
      }
    }
    
    // Look for company name patterns in the content
    const companyPatterns = [
      /(?:Welcome to|About)\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\s*[\||-]|\s*$)/i,
      /^([A-Z][A-Za-z0-9\s&.]+?)\s*(?:is|offers|provides|builds)/im,
      /©\s*\d{4}\s+([A-Z][A-Za-z0-9\s&.]+?)(?:\s|$)/i,
    ];
    
    for (const pattern of companyPatterns) {
      const match = markdown.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Validate the name against the domain
        const nameLower = name.toLowerCase().replace(/\s+/g, '');
        if (nameLower.includes(baseDomain) || baseDomain.includes(nameLower.substring(0, 4))) {
          console.log(`[ORCHESTRATOR] Found company name via pattern: ${name}`);
          return name;
        }
      }
    }
    
    // Try metadata title but validate against domain
    if (metadata.title && typeof metadata.title === 'string') {
      const cleaned = metadata.title
        .replace(/\s*[\||-]\s*(?:Official\s*)?(?:Website|Site|Home|Page)?\s*$/gi, '')
        .replace(/\s*[\||-]\s*[^|]+$/i, '')
        .replace(/\s*:\s*[^:]+$/i, '')
        .replace(/\s*-\s*[^-]+$/i, '')
        .replace(/\.com.*$/i, '')
        .replace(/is for sale.*$/i, '')
        .trim();
      
      if (cleaned && cleaned.length > 2) {
        const cleanedLower = cleaned.toLowerCase().replace(/\s+/g, '');
        // Validate against domain
        if (cleanedLower.includes(baseDomain) || baseDomain.includes(cleanedLower.substring(0, 4))) {
          console.log(`[ORCHESTRATOR] Found company name in title: ${cleaned}`);
          return cleaned;
        }
      }
    }
    
    // Last resort: use the domain name with proper capitalization
    const words = baseDomain.split('-').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    );
    const fallbackName = words.join(' ');
    console.log(`[ORCHESTRATOR] Using domain-based fallback: ${fallbackName}`);
    
    return fallbackName;
  }
  
  private extractDescription(scraped: { markdown?: string; metadata?: { description?: string; title?: string } }): string | null {
    // First check if this is a valid company website
    if (!this.isValidCompanyWebsite(scraped)) {
      console.log('[ORCHESTRATOR] Invalid company website detected, skipping description extraction');
      return null;
    }
    
    const metadata = scraped.metadata || {};
    const markdown = scraped.markdown || '';
    
    // Try meta description
    if (metadata.description && typeof metadata.description === 'string' && metadata.description.length > 20) {
      return metadata.description;
    }
    
    // Look for about sections
    const aboutMatch = markdown.match(
      /(?:About|Mission|What\s+We\s+Do)[\s:]+([^\n]+(?:\n[^\n]+){0,2})/i
    );
    if (aboutMatch) {
      return aboutMatch[1].trim().replace(/\n+/g, ' ');
    }
    
    return null;
  }
  
  private async extractFromSearchResults(
    searchResults: Array<{ url: string; title?: string; markdown?: string }>,
    fields: EnrichmentField[],
    context: Record<string, unknown>,
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<Record<string, unknown>> {
    console.log('[AGENT-DISCOVERY] Extracting from search results...');
    
    if (searchResults.length === 0) {
      return {};
    }
    
    if (onAgentProgress) {
      onAgentProgress(`Analyzing content from ${searchResults.length} sources...`, 'info');
    }
    
    // Combine search results for LLM extraction
    const combinedContent = this.trimSearchResultsContent(searchResults.slice(0, 5), 100000); // Smaller limit for extraction
    
    // Include context to help LLM understand what we're looking for
    const emailContext = context.emailContext as EmailContext;
    const extractionPrompt = `
Looking for information about a company with:
- Email domain: ${emailContext.domain}
- Possible company domain: ${emailContext.companyDomain || 'Unknown'}
- Possible company name: ${emailContext.companyNameGuess || 'Unknown'}

Extract the following information ONLY for this specific company:
${fields.map(f => `- ${f.displayName}: ${f.description}`).join('\n')}

IMPORTANT: Only extract information that is clearly about the company associated with the email domain ${emailContext.domain}.
    `.trim();
    
    const fullContent = extractionPrompt + '\n\n---\n\n' + combinedContent;
    
    try {
      if (onAgentProgress) {
        onAgentProgress(`Using AI to extract ${fields.map(f => f.name).join(', ')}...`, 'info');
      }
      
      // Use OpenAI to extract structured data
      // Convert context to string values only
      const stringContext: Record<string, string> = {};
      Object.entries(context).forEach(([key, value]) => {
        if (typeof value === 'string') {
          stringContext[key] = value;
        } else if (value != null) {
          stringContext[key] = String(value);
        }
      });
      
      const enrichmentResults = await this.openai.extractStructuredDataOriginal(
        fullContent,
        fields,
        stringContext
      );
      
      const foundFields = Object.keys(enrichmentResults).filter(k => enrichmentResults[k]?.value);
      if (onAgentProgress && foundFields.length > 0) {
        onAgentProgress(`Successfully extracted ${foundFields.length} fields from search results`, 'success');
      }
      
      // Add sources
      for (const [, enrichment] of Object.entries(enrichmentResults)) {
        if (enrichment && enrichment.value) {
          enrichment.source = searchResults.slice(0, 2).map(r => r.url).join(', ');
          enrichment.sourceContext = searchResults.slice(0, 2).map(r => ({
            url: r.url,
            snippet: r.title || ''
          }));
        }
      }
      
      return enrichmentResults;
    } catch (error) {
      console.error('[AGENT-DISCOVERY] Failed to extract from search results:', error);
      return {};
    }
  }
  
  private inferFromDomain(
    emailContext: EmailContext,
    fields: EnrichmentField[]
  ): Record<string, unknown> {
    console.log('[AGENT-DISCOVERY] Using domain-based inference as last resort');
    const results: Record<string, unknown> = {};
    
    if (!emailContext.companyDomain) {
      return results;
    }
    
    // Extract domain parts
    const domainParts = emailContext.companyDomain.split('.');
    const primaryDomain = domainParts[0].toLowerCase();
    
    // Known company mappings
    const knownCompanies: Record<string, string> = {
      'onetrust': 'OneTrust',
      'sideguide': 'Sideguide',
      'frontapp': 'Front',
      'shippo': 'Shippo',
      'lattice': 'Lattice',
      'pilot': 'Pilot',
      'fundera': 'Fundera',
      'flexport': 'Flexport',
      'triplebyte': 'Triplebyte',
      'zola': 'Zola',
      'pinterest': 'Pinterest',
      'brex': 'Brex',
      'deel': 'Deel',
      'scale': 'Scale AI',
      'wiz': 'Wiz',
      'firecrawl': 'Firecrawl',
    };
    
    // Get proper company name
    const cleanedName = knownCompanies[primaryDomain] || 
      primaryDomain
        .replace(/-/g, ' ')
        .replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    
    // Try to infer fields based on domain
    for (const field of fields) {
      const fieldName = field.name.toLowerCase();
      
      if (fieldName.includes('company') && fieldName.includes('name')) {
        // Use cleaned domain name as company name
        results[field.name] = {
          field: field.name,
          value: cleanedName,
          confidence: 0.3, // Low confidence
          source: 'Inferred from domain',
          sourceContext: [{
            url: `https://${emailContext.companyDomain}`,
            snippet: `Inferred from email domain: ${emailContext.companyDomain}`
          }]
        };
      } else if (fieldName.includes('website')) {
        // Use domain as website
        results[field.name] = {
          field: field.name,
          value: `https://${emailContext.companyDomain}`,
          confidence: 0.7, // Higher confidence for website
          source: 'Inferred from domain',
          sourceContext: [{
            url: `https://${emailContext.companyDomain}`,
            snippet: `Primary domain from email address`
          }]
        };
      } else if (fieldName.includes('description')) {
        // Generic description based on domain
        results[field.name] = {
          field: field.name,
          value: `${cleanedName} is a company that operates the ${emailContext.companyDomain} domain.`,
          confidence: 0.2, // Very low confidence
          source: 'Inferred from domain',
          sourceContext: [{
            url: `https://${emailContext.companyDomain}`,
            snippet: `No company description found - generic inference from domain`
          }]
        };
      }
    }
    
    console.log(`[AGENT-DISCOVERY] Inferred ${Object.keys(results).length} fields from domain`);
    return results;
  }
  
  private trimSearchResultsContent(
    searchResults: Array<{ url: string; title?: string; markdown?: string; content?: string }>,
    maxTotalChars: number = 300000
  ): string {
    // First, calculate total content size
    let totalSize = 0;
    const resultsWithSize = searchResults.map(r => {
      const content = r.markdown || r.content || '';
      const size = content.length;
      totalSize += size;
      return { ...r, contentSize: size };
    });
    
    // If under limit, return as is
    if (totalSize <= maxTotalChars) {
      return searchResults
        .map((r) => `URL: ${r.url}\n[PAGE TITLE - NOT CONTENT]: ${r.title || 'No title'}\n\n=== ACTUAL CONTENT BELOW ===\n${r.markdown || r.content || ''}`)
        .filter(Boolean)
        .join('\n\n---\n\n');
    }
    
    // Otherwise, trim proportionally
    console.log(`[ORCHESTRATOR] Content size ${totalSize} exceeds limit ${maxTotalChars}, trimming...`);
    
    // Calculate chars per result (ensure at least 1000 chars per result)
    const charsPerResult = Math.max(1000, Math.floor(maxTotalChars / searchResults.length));
    
    return resultsWithSize
      .map((r) => {
        const content = r.markdown || r.content || '';
        const trimmedContent = content.length > charsPerResult 
          ? content.substring(0, charsPerResult) + '\n[... content trimmed ...]'
          : content;
        
        return `URL: ${r.url}\n[PAGE TITLE - NOT CONTENT]: ${r.title || 'No title'}\n\n=== ACTUAL CONTENT BELOW ===\n${trimmedContent}`;
      })
      .filter(Boolean)
      .join('\n\n---\n\n');
  }
}