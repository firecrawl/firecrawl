/**
 * Firecrawl Java SDK — a type-safe client for the Firecrawl v2 web scraping API.
 *
 * <p>Quick start:
 * <pre>{@code
 * import com.firecrawl.client.FirecrawlClient;
 * import com.firecrawl.models.*;
 *
 * FirecrawlClient client = FirecrawlClient.builder()
 *     .apiKey("fc-your-api-key")
 *     .build();
 *
 * Document doc = client.scrape("https://example.com",
 *     ScrapeOptions.builder()
 *         .formats(List.of("markdown"))
 *         .build());
 *
 * System.out.println(doc.getMarkdown());
 * }</pre>
 *
 * @see com.firecrawl.client.FirecrawlClient
 */
package com.firecrawl;
