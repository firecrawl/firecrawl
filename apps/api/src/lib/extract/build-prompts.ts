export function buildRefrasedPrompt(prompt: string, url: string): string {
  return `You are a search query optimizer. Your task is to rephrase the following prompt into an effective search query that will find relevant results about this topic on ${url}.

Original prompt: "${prompt}"

Provide a rephrased search query that:
1. Maintains the core intent of the original prompt with ONLY the keywords
2. Uses relevant keywords
3. Is optimized for search engine results
4. Is concise and focused
5. Short is better than long
6. It is a search engine, not a chatbot
7. Concise, no more than 3 words besides the site

Return only the rephrased search query, without any explanation or additional text.`;
}

export function buildPreRerankPrompt(
  prompt: string | undefined,
  schema: any,
  url: string,
): string {
  const schemaString = JSON.stringify(schema, null, 2);
  return `Create a concise search query that combines the key data points from both the schema and prompt. Focus on the core information needed while keeping it general enough to find relevant matches.

Schema: ${schemaString}
Prompt: ${prompt}
Website to get content from: ${url}

Return only a concise sentece or 2 focused on the essential data points that the user wants to extract. This will be used by an LLM to determine how releavant the links that are present are to the user's request.`;
}

export function buildRerankerSystemPrompt(): string {
  return `You are a relevance expert scoring links from a website the user is trying to extract information from. Analyze the provided URLs and their content
to determine their relevance to the user's query and intent. 
    For each URL, assign a relevance score between 0 and 1, where 1
     means highly relevant and we should extract the content from it and 0 means not relevant at all, we should not extract the content from it.
      Always return all the links scored that you are giving. Do not omit links. 
     Always return the links in the same order they were provided. If the user wants the content from all the links, all links should be scored 1.`;
}

export function buildRerankerUserPrompt(searchQuery: string): string {
  return `Given these URLs and their content, analyze their relevance to this extraction request: "${searchQuery}".

For each URL, consider:
1. How well it matches the extraction needs
2. The quantity and quality of extractable information
3. Whether the content structure matches what we're looking for

Score each URL from 0-1 based on the scoring guidelines provided in the system prompt.

Provide detailed reasoning for each URL to explain why you assigned that score, considering:
- Content relevance
- Information completeness
- Structure suitability
- Potential extraction value`;
}

// Multi entity schema anlayzer
export function buildAnalyzeSchemaPrompt(): string {
  return `You are a query classifier for a web scraping system. Classify the data extraction query as either:
A) Single-Answer: One answer across a few pages, possibly containing small arrays.
B) Multi-Entity: Many items across many pages, often involving large arrays.

Consider:
1. Answer Cardinality: Single or multiple items?
2. Page Distribution: Found on 1-3 pages or many?
3. Verification Needs: Cross-page verification or independent extraction?

Provide:
- Method: [Single-Answer/Multi-Entity]
- Confidence: [0-100%]
- Reasoning: Why this classification?
- Key Indicators: Specific aspects leading to this decision.

Examples:
- "Is this company a non-profit?" -> Single-Answer
- "Extract all product prices" -> Multi-Entity

For Single-Answer, arrays may be present but are typically small. For Multi-Entity, if arrays have multiple items not from a single page, return keys with large arrays. If nested, return the full key (e.g., 'ecommerce.products').`;
}

export function buildAnalyzeSchemaUserPrompt(
  schemaString: string,
  prompt: string,
  urls: string[],
): string {
  return `Classify the query as Single-Answer or Multi-Entity. For Multi-Entity, return keys with large arrays; otherwise, return none:
Schema: ${schemaString}\nPrompt: ${prompt}\n URLs: ${urls}`;
}

// Should Extract

export function buildShouldExtractSystemPrompt(): string {
  return `You are a content relevance checker. Your job is to determine if the provided content is very relevant to extract information from based on the user's prompt. Return true only if the content appears relevant and contains information that could help answer the prompt. Return false if the content seems irrelevant or unlikely to contain useful information for the prompt.`;
}

export function buildShouldExtractUserPrompt(
  prompt: string,
  schema: any,
): string {
  return `Should the following content be used to extract information for this prompt: "${prompt}" User schema is: ${JSON.stringify(schema)}\nReturn only true or false.`;
}

// Batch extract
export function buildBatchExtractSystemPrompt(
  systemPrompt: string,
  multiEntitySchema: any,
  links: string[],
): string {
  return (
    (systemPrompt ? `${systemPrompt}\n` : "") +
    `Always prioritize using the provided content to answer the question. Do not make up an answer. Do not hallucinate. In case you can't find the information and the string is required, instead of 'N/A' or 'Not speficied', return an empty string: '', if it's not a string and you can't find the information, return null. Be concise and follow the schema always if provided. If the document provided is not relevant to the prompt nor to the final user schema ${JSON.stringify(multiEntitySchema)}, return null.`
  );
}

export function buildBatchExtractPrompt(prompt: string): string {
  return `Today is: ${new Date().toISOString()}\n${prompt}`;
}


export function buildRephraseToSerpPrompt(prompt: string): string {
  return `Rephrase the following prompt to be suitable for a search engine results page (SERP) query. Make sure the rephrased prompt is concise and focused on retrieving relevant search results:

Original Prompt: "${prompt}"`;
}

export function buildCrawlerOptionsPrompt(prompt: string): string {
  return `You are a web crawler configuration expert. Based on the user's natural language instruction, generate appropriate crawler options.

User instruction: "${prompt}"

Generate a JSON object with crawler configuration options. Available options:
- includePaths: string[] - URL patterns to include (regex patterns)
- excludePaths: string[] - URL patterns to exclude (regex patterns)  
- maxDepth: number - Maximum crawl depth (default: 10)
- crawlEntireDomain: boolean - Whether to crawl the entire domain
- allowExternalLinks: boolean - Whether to follow external links
- allowSubdomains: boolean - Whether to crawl subdomains
- ignoreRobotsTxt: boolean - Whether to ignore robots.txt
- sitemap: "skip" | "include" - Whether to ignore sitemap
- deduplicateSimilarURLs: boolean - Whether to deduplicate similar URLs
- ignoreQueryParameters: boolean - Whether to ignore query parameters
- regexOnFullURL: boolean - Whether regex patterns apply to full URL
- delay: number - Delay between requests in milliseconds

Return only a valid JSON object with the appropriate options based on the user's intent. If the instruction doesn't clearly map to specific options, use reasonable defaults.`;
}
