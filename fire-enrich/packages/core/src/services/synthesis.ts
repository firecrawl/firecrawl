import { z } from 'zod';
import type { EnrichmentField, EnrichmentResult } from '../types/index.js';
import type { LLMProvider } from '../llm/provider.js';
import { OpenAIProvider } from '../llm/openai-provider.js';

export class OpenAIService {
  private provider: LLMProvider;

  constructor(providerOrApiKey: LLMProvider | string) {
    this.provider = typeof providerOrApiKey === 'string'
      ? new OpenAIProvider(providerOrApiKey)
      : providerOrApiKey;
  }

  /** Alias for the new provider-based constructor */
  static fromProvider(provider: LLMProvider): OpenAIService {
    return new OpenAIService(provider);
  }

  createEnrichmentSchema(fields: EnrichmentField[]) {
    const schemaProperties: Record<string, z.ZodTypeAny> = {};

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

      if (!field.required) {
        fieldSchema = fieldSchema.nullable();
      }

      schemaProperties[field.name] = fieldSchema;
    });

    // Add confidence scores and source evidence for each field
    const confidenceProperties: Record<string, z.ZodTypeAny> = {};
    const sourceEvidenceProperties: Record<string, z.ZodTypeAny> = {};
    fields.forEach(field => {
      confidenceProperties[`${field.name}_confidence`] = z.number().min(0).max(1);
      // Each field can have multiple sources with their own quotes
      sourceEvidenceProperties[`${field.name}_sources`] = z.array(z.object({
        url: z.string(),
        quote: z.string()
      })).nullable();
    });

    return z.object({
      ...schemaProperties,
      ...confidenceProperties,
      ...sourceEvidenceProperties,
    });
  }

  createCorroboratedEnrichmentSchema(fields: EnrichmentField[]) {
    const schemaProperties: Record<string, z.ZodTypeAny> = {};

    fields.forEach(field => {
      // Create typed schema for value based on field type
      let valueSchema: z.ZodTypeAny;
      switch (field.type) {
        case 'string':
          valueSchema = z.string();
          break;
        case 'number':
          valueSchema = z.number();
          break;
        case 'boolean':
          valueSchema = z.boolean();
          break;
        case 'array':
          valueSchema = z.array(z.string());
          break;
        default:
          valueSchema = z.string();
      }
      // Make it nullable since evidence might not find the value
      valueSchema = valueSchema.nullable();

      // Each field has an array of evidence from different sources
      const evidenceSchema = z.object({
        value: valueSchema, // Use typed schema instead of z.any()
        source_url: z.string(), // Which URL this came from
        exact_text: z.string(), // The exact text where this was found
        confidence: z.number().min(0).max(1), // Confidence for this specific source
      });

      schemaProperties[field.name] = z.object({
        evidence: z.array(evidenceSchema),
        consensus_value: valueSchema, // Use same typed schema for consensus
        consensus_confidence: z.number().min(0).max(1), // Overall confidence
        sources_agree: z.boolean(), // Do all sources agree on the value?
      });
    });

    return z.object(schemaProperties);
  }

  async extractStructuredDataOriginal(
    content: string,
    fields: EnrichmentField[],
    context: Record<string, string>
  ): Promise<Record<string, EnrichmentResult>> {
    try {
      const schema = this.createEnrichmentSchema(fields);
      const fieldDescriptions = fields
        .map(f => `- ${f.name}: ${f.description}`)
        .join('\n');

      // Format context to emphasize company identity
      
      const contextInfo = Object.entries(context)
        .map(([key, value]) => {
          if (key === 'targetDomain' && value) {
            return `Company Domain: ${value} (if you see content from this domain, it's likely the target company)`;
          }
          if (key === 'name' || key === '_parsed_name') {
            return `Person Name: ${value}`;
          }
          return `${key}: ${value}`;
        })
        .filter(line => !line.includes('undefined'))
        .join('\n');

      // Trim content to prevent token overflow
      const MAX_CONTENT_CHARS = 400000; // Conservative limit for 128k token model
      
      let trimmedContent = content;
      if (content.length > MAX_CONTENT_CHARS) {
        console.log(`[OPENAI] Content too long (${content.length} chars), trimming to ${MAX_CONTENT_CHARS} chars`);
        trimmedContent = content.substring(0, MAX_CONTENT_CHARS) + '\n\n[Content truncated due to length...]';
      }

      const response = await this.provider.complete({
        tier: 'smart',
        messages: [
          {
            role: 'system',
            content: `You are an expert data extractor. Extract the requested information from the provided content with high accuracy.
            
**CRITICAL RULE**: You MUST ONLY extract information that is EXPLICITLY STATED in the provided content. DO NOT make up, guess, or infer any values. If the information is not clearly present in the text, you MUST return null.

**IMPORTANT**: If a Person Name is provided in the context, you should:
1. Look for information about THAT SPECIFIC PERSON's current company/employer
2. Extract information about the company where this person currently works
3. Do NOT extract information about other companies mentioned unless they are the person's current employer

For each field, you must provide:
1. The extracted value (or null if not found)
2. A confidence score between 0 and 1
3. A sources array - an array of objects, each containing:
   - url: The URL where you found this information (from "URL:" in content)
   - quote: The EXACT text from THAT SPECIFIC source about this field (NOT shared across sources)

Confidence scores:
- 1.0: Information is explicitly stated with exact values/text in the provided content
- 0.8-0.9: Information is clearly present with minor inference needed
- 0.5-0.7: Information requires some interpretation but is based on actual content
- 0.3-0.4: Information is unclear or contradictory
- 0.0-0.2: Information is NOT FOUND in the content

**MANDATORY**: 
1. If you cannot find the specific information, return null for that field
2. Set confidence to 0.0 if not found
3. For the sources array, include EACH source that mentions the information
4. IMPORTANT: Each source must have its OWN unique quote from that specific URL - extract the actual text from each source
5. CRITICAL: Only use URLs that are explicitly listed in the content after "URL:" - do NOT create or modify URLs

**EXAMPLE**:
If you're looking for info about "Example Corp" and the content contains:
"URL: techcrunch.com ... Example Corp has grown to 150 employees this year..."
"URL: forbes.com ... The company Example Corp now employs 150 people..."
"URL: seekcompany.com ... Seek offers AI for data analytics with 200 employees..."

For Example Corp's employee count, you would return:
{
  "employeeCount": 150,
  "employeeCount_confidence": 1.0,
  "employeeCount_sources": [
    {"url": "techcrunch.com", "quote": "Example Corp has grown to 150 employees this year"},
    {"url": "forbes.com", "quote": "The company Example Corp now employs 150 people"}
  ]
}

**ACCEPTABLE VARIATIONS**:
If looking for "Seek AI" and find:
- "Seek offers AI for data" from seek.ai domain → This IS the same company
- "Seek has 200 employees" from seek.ai → This IS valid

**WRONG EXAMPLE**:
If looking for "Example Corp" but finding "Microsoft has 200,000 employees":
- Value: null (because Microsoft is clearly a different company)
- Confidence: 0.0
- Source quote: null
- Source URLs: null

**CRITICAL**: Use domain names and context to verify if it's the same company. Be smart about name variations.

**TARGET ENTITY - IMPORTANT**: You are ONLY extracting information about:
${contextInfo}

**CRITICAL**: 
- Only extract information about the TARGET ENTITY listed above
- Company name variations are OK (e.g., "Seek AI" vs "Seek", "OpenAI" vs "Open AI")
- Look for domain matches (e.g., if searching for "Seek AI" and you see content from seek.ai, that's likely the same company)
- Common variations to accept:
  - With/without "Inc", "Corp", "LLC", "Ltd"
  - With/without spaces in compound names
  - With/without industry descriptors ("AI", "Software", etc.)
- Use proper capitalization for known companies (e.g., "OneTrust" not "onetrust", "Scale AI" not "scale")
- Always capitalize industry names properly (e.g., "Technology", "Healthcare", "E-commerce", "Finance")
- If you find information about CLEARLY DIFFERENT companies, IGNORE IT

Fields to extract for the TARGET ENTITY ONLY:
${fieldDescriptions}

ADDITIONAL GUIDELINES:
1. Employee Count: Must be explicitly stated. Look for phrases like "X employees", "team of X", "X people". If not found, return null.
2. Funding Stage: Must be explicitly mentioned (e.g., "raised Series A", "seed funding"). If not found, return null.
3. Revenue: Must be explicitly stated with numbers. If not found, return null.
4. Year Founded: Must be explicitly mentioned (e.g., "founded in X", "established X"). If not found, return null.
5. DO NOT use general knowledge or make educated guesses.
6. DO NOT fill in values based on what seems likely.
7. ONLY extract what is ACTUALLY WRITTEN in the provided content.
8. When multiple sources mention the same field, extract the ACTUAL QUOTE from EACH source - do not copy the same quote to multiple sources.

REMEMBER: It is better to return null than to guess or make up information.

CRITICAL FOR SOURCES: Each URL in the content has its own unique text. When you find information in multiple sources:
- Go to each URL section in the content
- Find the EXACT sentence/phrase from THAT specific URL
- Do NOT reuse quotes across different URLs
- Each source should have its own unique quote as it appears in that source

DOMAIN PARKING/SALE PAGES:
- If you see content about "domain for sale", "buy this domain", "make an offer", "checkout the full domain details", etc., this is NOT valid company information
- Domain parking pages are NOT legitimate sources - return null for all fields if only parking pages are found
- Look for actual company websites with real business information`,
          },
          {
            role: 'user',
            content: trimmedContent,
          },
        ],
        schema, schemaName: 'enrichment_data',
      });

      const messageContent = response.text;
      if (!messageContent) {
        throw new Error('No response content');
      }
      
      const parsed = JSON.parse(messageContent);

      // Transform the flat structure into EnrichmentResult format
      const results: Record<string, EnrichmentResult> = {};
      
      fields.forEach(field => {
        let value = parsed[field.name];
        let confidence = parsed[`${field.name}_confidence`] as number;
        const sourcesWithQuotes = parsed[`${field.name}_sources`] as Array<{url: string, quote: string}> | null;
        
        // Filter out invalid placeholder values
        if (value === '/' || value === '-' || value === 'N/A' || value === 'n/a') {
          value = null;
        }
        
        // Post-processing validation for specific fields
        if (value !== null && value !== undefined) {
          // Employee count validation
          if ((field.name === 'employeeCount' || field.displayName === 'Employee Count') && typeof value === 'number') {
            if (value > 1000000) {
              // Likely a parsing error (e.g., "500+" interpreted as 500,000)
              console.warn(`Unrealistic employee count detected: ${value}. Reducing confidence.`);
              confidence = Math.min(confidence, 0.3);
            }
          }
          
          // Year founded validation
          if ((field.name === 'yearFounded' || field.displayName === 'Year Founded') && typeof value === 'number') {
            const currentYear = new Date().getFullYear();
            if (value < 1800 || value > currentYear) {
              confidence = Math.min(confidence, 0.2);
            }
          }
          
          // Funding stage normalization
          if ((field.name === 'fundingStage' || field.displayName === 'Funding Stage') && typeof value === 'string') {
            // Normalize funding stage values
            const normalized = value.toLowerCase();
            if (normalized.includes('seed') && !normalized.includes('pre')) {
              value = 'Seed';
            } else if (normalized.includes('pre-seed') || normalized.includes('preseed')) {
              value = 'Pre-seed';
            } else if (normalized.match(/series\s*[a-e]/i)) {
              const series = normalized.match(/series\s*([a-e])/i)?.[1]?.toUpperCase();
              if (series) value = `Series ${series}`;
            }
          }
        }
        
        // Only include results with actual data found (confidence > 0.3)
        // This prevents hallucinated data from being shown
        if (value !== null && value !== undefined && confidence > 0.3) {
          results[field.name] = {
            field: field.name,
            value,
            confidence,
            source: sourcesWithQuotes ? sourcesWithQuotes.map(s => s.url).join(', ') : 'structured_extraction',
            sourceContext: sourcesWithQuotes ? sourcesWithQuotes.map(s => ({
              url: s.url,
              snippet: s.quote
            })) : undefined,
            // Don't set sourceCount here - let the UI count actual sources after filtering
          };
        }
      });

      return results;
    } catch (error) {
      console.error('OpenAI extraction error:', error);
      throw new Error('Failed to extract structured data');
    }
  }

  async extractStructuredDataWithCorroboration(
    content: string,
    fields: EnrichmentField[],
    context: Record<string, string>,
    onMessage?: (message: string, type: 'info' | 'success' | 'warning' | 'agent', sourceUrl?: string) => void
  ): Promise<Record<string, EnrichmentResult>> {
    try {
      console.log('Starting corroborated extraction for fields:', fields.map(f => f.name));
      
      const schema = this.createCorroboratedEnrichmentSchema(fields);
      const fieldDescriptions = fields
        .map(f => `- ${f.name}: ${f.description}`)
        .join('\n');

      // Format context to emphasize company identity
      
      const contextInfo = Object.entries(context)
        .map(([key, value]) => {
          if (key === 'targetDomain' && value) {
            return `Company Domain: ${value} (if you see content from this domain, it's likely the target company)`;
          }
          if (key === 'name' || key === '_parsed_name') {
            return `Person Name: ${value}`;
          }
          return `${key}: ${value}`;
        })
        .filter(line => !line.includes('undefined'))
        .join('\n');

      // Add custom instructions if provided
      const customInstructions = context.instruction ? `\n\n**SPECIFIC INSTRUCTIONS FOR THIS EXTRACTION**:\n${context.instruction}` : '';
      
      // Trim content to prevent token overflow
      // Approximate: 1 token ≈ 4 characters, GPT-4o has 128k token limit
      // Reserve ~8k tokens for system prompt, response format, and response
      // That leaves ~120k tokens for content = ~480k characters
      const MAX_CONTENT_CHARS = 400000; // Conservative limit
      
      let trimmedContent = content;
      if (content.length > MAX_CONTENT_CHARS) {
        console.log(`[OPENAI] Content too long (${content.length} chars), trimming to ${MAX_CONTENT_CHARS} chars`);
        trimmedContent = content.substring(0, MAX_CONTENT_CHARS) + '\n\n[Content truncated due to length...]';
      }
      
      const response = await this.provider.complete({
        tier: 'smart',
        messages: [
          {
            role: 'system',
            content: `You are an expert data extractor. Extract information with evidence from each source.

**CRITICAL INSTRUCTIONS**:
1. For EACH field, find ALL mentions across ALL sources
2. Return an array of evidence for each field
3. Each evidence entry must include:
   - value: The exact value found (or null if not found)
   - source_url: The URL where this was found
   - exact_text: The EXACT sentence/phrase containing this information (copy verbatim)
   - confidence: How confident you are in this specific extraction (0-1)
4. ONLY include evidence that is EXPLICITLY STATED in the content
5. DO NOT make up or infer values
6. If a source doesn't mention a field, DO NOT create evidence for it
7. For consensus_value: Choose the most common/reliable value from the evidence
8. For sources_agree: Set to true only if all sources have the same value
9. NEVER use placeholder values like "/", "-", "N/A", or "n/a" - use null instead
10. If information is not found, consensus_value should be null
11. DO NOT create fake URLs - only use URLs that actually appear in the content
12. ALWAYS capitalize fields properly:
    - Industry names should be capitalized (e.g., "Technology", "Healthcare", "Finance")
    - Company names should use proper casing (e.g., "OneTrust" not "onetrust")
    - Job titles should be capitalized (e.g., "Chief Executive Officer", "VP of Sales")
13. **CRITICAL URL VALIDATION**:
    - ONLY use URLs that appear after "URL:" in the content
    - DO NOT invent or guess URLs
    - DO NOT modify or create URLs based on company names
    - If you extract data but can't find which URL it came from, use the URL that appears closest before that content

**CRITICAL REQUIREMENT FOR exact_text**:
- The exact_text MUST be a complete sentence or paragraph from the content that contains the value
- The exact_text MUST contain the actual value you're extracting
- If extracting "150 employees", the exact_text must contain "150" and "employees"
- If extracting "San Francisco, CA", the exact_text must contain "San Francisco"
- DO NOT include text that merely mentions the field name without the value
- DO NOT include surrounding context that doesn't contain the value itself
- The exact_text should typically be 20-200 characters and include proper punctuation
- The exact_text should read like a natural sentence, not a title or heading

**INVALID EVIDENCE EXAMPLES**:
- Field: employeeCount, Value: 150
  - WRONG: "The company has grown significantly in recent years"
  - WRONG: "Check our careers page for employee information"
  - WRONG: "About Us - Acme Corp" (this is just a page title)
  - WRONG: "Acme Corp | Official Website" (this is just a title)
  - RIGHT: "We now have 150 employees across our offices"

- Field: headquarters, Value: "San Francisco, CA"
  - WRONG: "We have offices worldwide"
  - WRONG: "Visit our headquarters page for location"
  - WRONG: "Contact Us | Acme Corp" (this is just a page title)
  - RIGHT: "Our headquarters is located in San Francisco, CA"

**CRITICAL**: Do NOT use page titles, headers, or navigation text as exact_text. The exact_text must be from the actual content that contains the value.${customInstructions}

Context about the entity:
${contextInfo}

Fields to extract:
${fieldDescriptions}

Example of what the content looks like:
"""
URL: https://example.com/about
[PAGE TITLE - NOT CONTENT]: About Us - Example Corp

=== ACTUAL CONTENT BELOW ===
Example Corp was founded in 2015 in San Francisco, CA. Our team of 150 employees works across 3 offices to deliver innovative solutions...
"""

Example format for employee count:
{
  "employeeCount": {
    "evidence": [
      {
        "value": 150,
        "source_url": "https://example.com/about",
        "exact_text": "Our team of 150 employees works across 3 offices",
        "confidence": 1.0
      },
      {
        "value": null,
        "source_url": "https://news.com/article",
        "exact_text": "",
        "confidence": 0.0
      }
    ],
    "consensus_value": 150,
    "consensus_confidence": 0.9,
    "sources_agree": false
  }
}

REMEMBER: Extract exact_text from the "=== ACTUAL CONTENT BELOW ===" section, NOT from the "[PAGE TITLE - NOT CONTENT]" line!

**CRITICAL URL EXTRACTION RULES**:
1. ONLY use URLs that appear in the content after "URL:" 
2. DO NOT create URLs based on company names
3. DO NOT modify URLs from the content
4. DO NOT guess or infer URLs
5. If you see "URL: https://example.com/about" in the content, use EXACTLY "https://example.com/about"
6. If no URL is found for a piece of evidence, set source_url to null
7. Common fake URL patterns to AVOID:
   - https://[companyname].com
   - https://www.[companyname].com  
   - https://companywebsite.com
   - Any URL with brackets or placeholders`
          },
          {
            role: 'user',
            content: trimmedContent,
          },
        ],
        schema, schemaName: 'corroborated_data',
        temperature: 0.1, // Lower temperature for more consistent extraction
      });

      const messageContent = response.text;
      if (!messageContent) {
        throw new Error('No response content');
      }
      
      const parsed = JSON.parse(messageContent);
      
      // Debug log raw evidence
      console.log('[OPENAI] Raw corroboration response sample:', {
        firstField: fields[0]?.name,
        evidence: parsed[fields[0]?.name]?.evidence?.slice(0, 2)
      });

      // Import validation function
      const { validateSnippetContainsValue } = await import('../utils/source-context.js');

      // Transform corroborated data into EnrichmentResult format
      const results: Record<string, EnrichmentResult> = {};
      
      fields.forEach(field => {
        const fieldData = parsed[field.name];
        if (!fieldData) return;
        
        // Only include if we have actual evidence with good confidence
        const validEvidence = fieldData.evidence.filter(
          (e: { value: unknown; confidence: number; exact_text: string; source_url: string }) => {
            // Basic validation
            if (e.value === null || e.confidence < 0.2) return false;
            
            // CRITICAL: Reject empty or missing evidence text
            if (!e.exact_text || e.exact_text.trim() === '') {
              console.log(`[VALIDATION] Rejecting evidence with no text for ${field.name}`);
              return false;
            }
            
            // Validate URL format and common hallucination patterns
            if (e.source_url) {
              try {
                const url = new URL(e.source_url);
                // Check for obviously fake URLs
                if (url.hostname === 'example.com' || 
                    url.hostname === 'companywebsite.com' ||
                    url.hostname === 'website.com' ||
                    url.hostname.includes('[') ||
                    url.hostname.includes('{')) {
                  console.log(`[VALIDATION] Rejecting hallucinated URL for ${field.name}: ${e.source_url}`);
                  return false;
                }
              } catch {
                console.log(`[VALIDATION] Rejecting invalid URL for ${field.name}: ${e.source_url}`);
                return false;
              }
            }
            
            // More robust title detection
            const textLower = e.exact_text ? e.exact_text.toLowerCase() : '';
            const hasSentenceEnding = /[.!?]/.test(e.exact_text);
            const wordCount = e.exact_text ? e.exact_text.split(/\s+/).length : 0;
            
            const looksLikeTitle = e.exact_text && (
              // Common title patterns
              e.exact_text.includes(' | ') ||
              (e.exact_text.includes(' - ') && !hasSentenceEnding) ||
              
              // Keywords that appear in titles/headers
              textLower.includes('official website') ||
              textLower.includes('wikipedia') ||
              textLower.includes('home page') ||
              
              // Short text without proper punctuation (likely a heading)
              (!hasSentenceEnding && wordCount < 15) ||
              
              // All caps or title case without sentences
              (e.exact_text.match(/^[A-Z][^.!?]*$/) && e.exact_text.length < 100) ||
              
              // Just a URL or very short
              e.exact_text === e.source_url ||
              e.exact_text.length < 20
            );
            
            if (looksLikeTitle) {
              console.log(`[VALIDATION] Filtering out title-like evidence for ${field.name}:`, e.exact_text);
              return false;
            }
            
            // Check for common hallucination patterns
            const hallucationPatterns = [
              /with the mission to revolutionize/i,
              /founded in \d{4} with the mission/i,
              /leading provider of innovative solutions/i,
              /cutting-edge technology company/i,
              /transforming the industry/i,
              /pioneering solutions/i,
              /dedicated to providing exceptional/i,
              /committed to excellence/i,
              /industry-leading platform/i,
              /state-of-the-art technology/i,
              /revolutionizing the way/i,
              /empowering businesses to/i,
              /leveraging cutting-edge/i,
              /comprehensive suite of/i,
              /seamlessly integrat/i,
              /innovative approach to/i,
              /next-generation platform/i,
              /world-class solutions/i,
              /best-in-class/i,
              /game-changing/i
            ];
            
            const looksLikeHallucination = hallucationPatterns.some(pattern => pattern.test(e.exact_text));
            if (looksLikeHallucination) {
              console.log(`[VALIDATION] Detected potential hallucination pattern in ${field.name}:`, e.exact_text);
              return false;
            }
            
            // Validate that the snippet actually contains the value
            const isValid = validateSnippetContainsValue(e.exact_text, e.value as string | number | boolean | string[]);
            if (!isValid) {
              console.log(`[VALIDATION] Filtering out evidence for ${field.name} - snippet doesn't contain value:`, {
                value: e.value,
                snippet: e.exact_text.substring(0, 100) + '...'
              });
            }
            return isValid;
          }
        );
        
        // CRITICAL: Only proceed if we have actual valid evidence
        if (validEvidence.length === 0) {
          console.log(`[VALIDATION] No valid evidence found for ${field.name}, skipping field`);
          return;
        }
        
        if (validEvidence.length > 0 && fieldData.consensus_confidence > 0.2) {
          // Validate the consensus value - filter out invalid values like "/"
          let consensusValue = fieldData.consensus_value;
          if (consensusValue === '/' || consensusValue === '-' || consensusValue === 'N/A' || consensusValue === 'n/a') {
            consensusValue = null;
          }
          
          // Only create result if we have a valid value
          if (consensusValue !== null && consensusValue !== undefined && consensusValue !== '') {
            // Filter sourceContext to only include validated evidence
            const validSourceContext = validEvidence
              .filter((e: { exact_text: string }) => e.exact_text && e.exact_text.trim() !== '')
              .map((e: { source_url: string; exact_text: string }) => ({
                url: e.source_url,
                snippet: e.exact_text,
              }));
            
            // Debug log what we're keeping
            if (validSourceContext.length > 0) {
              console.log(`[SOURCE-CONTEXT] For ${field.name}, keeping ${validSourceContext.length} sources:`,
                validSourceContext.map(sc => ({ url: sc.url, snippet: sc.snippet.substring(0, 50) + '...' }))
              );

              // Send source context to UI
              if (onMessage) {
                validSourceContext.forEach((sc, idx) => {
                  onMessage(
                    `Found evidence for ${field.displayName || field.name}: "${sc.snippet.substring(0, 100)}..."`,
                    'info',
                    sc.url
                  );
                });
              }
            }
            
            // Final validation - if all snippets look like titles, clear them
            const allSnippetsAreTitles = validSourceContext.every(sc => {
              const text = sc.snippet;
              const hasSentenceEnding = /[.!?]/.test(text);
              const hasTitle = text.includes(' | ') || (text.includes(' - ') && !hasSentenceEnding);
              return hasTitle || (!hasSentenceEnding && text.split(/\s+/).length < 15);
            });
            
            if (allSnippetsAreTitles) {
              console.log(`[VALIDATION] All snippets for ${field.name} look like titles, clearing source context`);
              validSourceContext.length = 0; // Clear the array
            }
            
            // Only include the field if we have valid source context OR if we have a value without context
            if (validSourceContext.length > 0 || consensusValue !== null) {
              // CRITICAL: Reduce confidence if we have no valid evidence
              let adjustedConfidence = fieldData.consensus_confidence;
              if (validSourceContext.length === 0) {
                console.log(`[CONFIDENCE] No valid evidence for ${field.name}, reducing confidence from ${adjustedConfidence} to 0.1`);
                adjustedConfidence = 0.1; // Force low confidence when no valid evidence
              }
              
              const enrichmentResult: EnrichmentResult = {
                field: field.name,
                value: consensusValue,
                confidence: adjustedConfidence,
                source: validEvidence.map((e: { source_url: string }) => e.source_url).join(', '),
                sourceContext: validSourceContext,
                corroboration: {
                  evidence: validEvidence, // Only include validated evidence
                  sources_agree: fieldData.sources_agree,
                },
              };
          
            // Additional validation for tech stack fields
            if (field.name.toLowerCase().includes('tech') || field.name.toLowerCase().includes('stack')) {
              // Validate GitHub URLs in evidence
              if (enrichmentResult.corroboration) {
                enrichmentResult.corroboration.evidence = enrichmentResult.corroboration.evidence.filter((e) => {
                if (e.source_url && e.source_url.includes('github.com')) {
                  // Check if this GitHub URL was provided in the context
                  const validGithubUrls = Array.isArray(context.validGithubUrls) ? context.validGithubUrls as string[] : [];
                  const isValid = validGithubUrls.includes(e.source_url);
                  if (!isValid) {
                    console.log(`[VALIDATION] Removing hallucinated GitHub URL from evidence: ${e.source_url}`);
                    return false;
                  }
                }
                return true;
                });
              }
              
              // Validate tech stack values
              if (Array.isArray(enrichmentResult.value)) {
                const genericTechs = ['website', 'web', 'internet', 'computer', 'software', 'technology', 'platform', 'system', 'application'];
                enrichmentResult.value = enrichmentResult.value.filter((tech) => {
                  const techStr = String(tech).toLowerCase().trim();
                  // Remove generic terms
                  if (genericTechs.includes(techStr)) return false;
                  // Remove single letters
                  if (techStr.length <= 1) return false;
                  // Remove if it's just punctuation or numbers
                  if (!/[a-zA-Z]/.test(techStr)) return false;
                  return true;
                });
                
                // If no valid technologies remain, skip this field
                if (enrichmentResult.value.length === 0) {
                  console.log(`[VALIDATION] No valid technologies found for ${field.name}, skipping field`);
                  return;
                }
              }
            }
            
            // Debug log to verify corroboration data
            if (fieldData.evidence.length > 0) {
              console.log(`Field ${field.name} has ${fieldData.evidence.length} evidence items, sources_agree: ${fieldData.sources_agree}`);
            }
            
            results[field.name] = enrichmentResult;
            }
          }
        }
      });

      return results;
    } catch (error) {
      console.error('OpenAI corroborated extraction error:', error);
      // Fallback to original extraction method
      return this.extractStructuredDataOriginal(content, fields, context);
    }
  }

  async extractStructuredData(
    prompt: string,
    schema: Record<string, string>
  ): Promise<Record<string, unknown>> {
    try {
      const schemaDescription = Object.entries(schema)
        .map(([key, type]) => `- ${key}: ${type}`)
        .join('\n');
      
      const response = await this.provider.complete({
        tier: 'fast',
        messages: [
          {
            role: 'system',
            content: `Extract structured data based on the prompt. Return valid JSON matching this schema:
${schemaDescription}

**CRITICAL RULES**:
1. ONLY extract information that is EXPLICITLY STATED in the provided content
2. DO NOT make up, guess, or infer any values
3. If information is not found in the content, you MUST use null
4. Return ONLY valid JSON
5. Ensure all strings are properly escaped
6. Keep values concise

**FORBIDDEN**: Do not use general knowledge or make educated guesses. Only extract what is ACTUALLY WRITTEN in the prompt.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        jsonMode: true,
        temperature: 0.3,
        maxTokens: 2000,
      });
      
      const content = response.text;
      if (!content) {
        console.warn('No content in OpenAI response');
        return {};
      }
      
      try {
        // Clean up potential issues
        const cleanedContent = content
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
          .replace(/\n\s*\n/g, '\n') // Remove extra newlines
          .trim();
        
        return JSON.parse(cleanedContent);
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        console.error('Content that failed to parse:', content.substring(0, 500) + '...');
        
        // Try to extract valid JSON if it's embedded
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0]);
          } catch {
            // Fall through to return empty object
          }
        }
        
        return {};
      }
    } catch (error) {
      console.error('OpenAI extraction error:', error);
      return {};
    }
  }

  async generateSearchQueries(
    context: Record<string, string>,
    targetField: string,
    existingQueries: string[] = []
  ): Promise<string[]> {
    try {
      const response = await this.provider.complete({
        tier: 'smart',
        messages: [
          {
            role: 'system',
            content: `Generate effective search queries to find information about "${targetField}" for the given entity.
            
Rules:
1. Generate 2-3 different search queries
2. Use various search strategies (company name + field, person name + company, domain search, etc.)
3. Make queries specific and likely to return relevant results
4. Avoid queries that are too generic
5. If email is provided, intelligently parse it to extract useful components`,
          },
          {
            role: 'user',
            content: `Context: ${JSON.stringify(context)}
            
Previous queries tried: ${existingQueries.join(', ')}
            
Generate new search queries to find: ${targetField}`,
          },
        ],
        jsonMode: true,
      });

      const result = JSON.parse(response.text || '{}');
      return result.queries || [];
    } catch (error) {
      console.error('Query generation error:', error);
      return [];
    }
  }

  async generateSearchQuery(question: string, context?: Record<string, unknown>): Promise<string> {
    try {
      const conversationHistory = (context?.conversationHistory as Array<{ role: string; content: string }>) || [];
      const currentDate = new Date().toISOString().split('T')[0];

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a search query optimizer. Convert natural language questions into effective search queries.

**Current date: ${currentDate}**

If the question is about recent/current data (funding, metrics, etc.), include the current year (${new Date().getFullYear()}) in the search query to get the most up-to-date results.

If the question references previous context (like "when was that"), use the conversation history to understand what the user is asking about.

Return ONLY the search query, nothing else.`
        }
      ];

      // Add conversation history for context
      if (conversationHistory.length > 0) {
        messages.push({
          role: 'system',
          content: `Previous conversation:\n${conversationHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')}`
        });
      }

      messages.push({
        role: 'user',
        content: `Question: ${question}\n\nContext: ${JSON.stringify(context || {})}\n\nGenerate the best search query:`
      });

      const response = await this.provider.complete({
        tier: 'fast',
        messages,
        temperature: 0.3,
        maxTokens: 100,
      });

      return response.text?.trim() || question;
    } catch (error) {
      console.error('Search query generation error:', error);
      return question;
    }
  }

  async answerFromTableData(
    question: string,
    tableData: string,
    conversationHistory?: Array<{ role: string; content: string }>
  ): Promise<{ found: boolean; answer?: string }> {
    try {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a data analyst examining enriched table data. Your job is to answer questions ONLY if the specific information is present in the data.

**CRITICAL RULES**:
1. ONLY answer if the EXACT information requested is in the table data
2. If the table has related data but NOT the specific field asked about, return "NOT_FOUND"
3. If asked about a field that doesn't exist in the data, return "NOT_FOUND"
4. Be precise - don't guess or make assumptions

**Examples**:
- Question: "How much funding has X raised?" → If table has name/company but NO funding field, return "NOT_FOUND"
- Question: "What is the employee count?" → If table has employeeCount field with value, answer with that value
- Question: "What is their revenue?" → If table has NO revenue field, return "NOT_FOUND"

When you CAN answer:
- Be concise and specific
- Cite the actual data points
- If multiple rows match, aggregate the information

When you CANNOT answer:
- Respond with EXACTLY "NOT_FOUND" (nothing else)`
        }
      ];

      // Add conversation history for context
      if (conversationHistory && conversationHistory.length > 0) {
        conversationHistory.forEach(msg => {
          messages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          });
        });
      }

      messages.push({
        role: 'user',
        content: `Current Date: ${new Date().toISOString().split('T')[0]}

Enriched Data Table:
${tableData}

Question: ${question}

**IMPORTANT**:
- DO NOT just describe the table or say how many rows it has
- ONLY answer if the SPECIFIC data requested exists in the table
- If the specific field is not in the table, return "NOT_FOUND"
- Be specific with your answer, citing actual data values`
      });

      const response = await this.provider.complete({
        tier: 'fast',
        messages,
        temperature: 0.1, // Lower temperature for more consistent behavior
        maxTokens: 500,
      });

      const answer = response.text?.trim() || '';

      // Check for NOT_FOUND or generic table descriptions
      const isGenericAnswer =
        answer === 'NOT_FOUND' ||
        answer.includes('NOT_FOUND') ||
        (answer.toLowerCase().includes('table contains') && answer.toLowerCase().includes('rows')) ||
        (answer.toLowerCase().includes('total') && answer.toLowerCase().includes('rows') && answer.split(' ').length < 15);

      if (isGenericAnswer) {
        console.log('[OPENAI] Table data check: NOT_FOUND (generic or not found)');
        return { found: false };
      }

      console.log('[OPENAI] Table data check: FOUND -', answer.substring(0, 100));
      return { found: true, answer };
    } catch (error) {
      console.error('Table data analysis error:', error);
      return { found: false };
    }
  }

  async selectBestSource(
    sources: Array<{ url: string; title?: string; description?: string }>,
    question: string
  ): Promise<{ url: string; title?: string }> {
    try {
      const response = await this.provider.complete({
        tier: 'fast',
        messages: [
          {
            role: 'system',
            content: 'You are a source evaluator. Select the best source to answer the question. Return JSON with {index: number}.'
          },
          {
            role: 'user',
            content: `Question: ${question}\n\nSources:\n${sources.map((s, i) => `${i}. ${s.title || s.url}\n${s.description || ''}`).join('\n\n')}\n\nSelect best source:`
          }
        ],
        temperature: 0.3,
        maxTokens: 50,
      });

      const result = JSON.parse(response.text || '{"index": 0}');
      return sources[result.index] || sources[0];
    } catch (error) {
      console.error('Source selection error:', error);
      return sources[0];
    }
  }

  async generateConversationalResponse(
    question: string,
    content: string,
    context?: Record<string, unknown>,
    sourceUrl?: string
  ): Promise<string> {
    try {
      const conversationHistory = (context?.conversationHistory as Array<{ role: string; content: string }>) || [];
      const currentDate = new Date().toISOString().split('T')[0];

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: `You are a helpful research assistant. Answer questions conversationally based on the provided content and previous conversation context.

**Current date: ${currentDate}**

Be concise but informative. If the content doesn't contain the answer, say so. When citing dates or time-sensitive information, consider the current date for context.`
        }
      ];

      // Add conversation history for context
      conversationHistory.forEach(msg => {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        });
      });

      // Add current question with content
      messages.push({
        role: 'user',
        content: `Question: ${question}\n\nContext: ${JSON.stringify(context || {})}\n\nContent from ${sourceUrl || 'source'}:\n${content.slice(0, 8000)}\n\nAnswer:`
      });

      const response = await this.provider.complete({
        tier: 'smart',
        messages,
        temperature: 0.7,
        maxTokens: 500,
      });

      return response.text?.trim() || "I couldn't find a clear answer to your question.";
    } catch (error) {
      console.error('Response generation error:', error);
      return "I encountered an error while processing your question.";
    }
  }
}