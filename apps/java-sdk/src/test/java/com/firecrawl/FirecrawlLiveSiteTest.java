package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.Document;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Live Site Test - Firecrawl.dev
 * 
 * Tests the Java SDK against the actual Firecrawl production website.
 * This demonstrates real-world usage of the API against live content.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.FirecrawlLiveSiteTest"
 */
class FirecrawlLiveSiteTest {

    private static FirecrawlClient client;

    @BeforeAll
    static void setup() {
        String apiKey = System.getenv("FIRECRAWL_API_KEY");
        if (apiKey != null && !apiKey.isBlank()) {
            client = FirecrawlClient.fromEnv();
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeFirecrawlHomepage() {
        System.out.println("\n=== Testing against LIVE Firecrawl.dev website ===\n");
        System.out.println("Scraping: https://firecrawl.dev");
        
        Document doc = client.scrape("https://firecrawl.dev",
                ScrapeOptions.builder()
                        .formats(List.of("markdown", "html"))
                        .onlyMainContent(true)
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        assertNotNull(doc.getHtml(), "HTML content should not be null");
        assertNotNull(doc.getMetadata(), "Metadata should not be null");
        
        // Verify it's actually the Firecrawl site
        String markdown = doc.getMarkdown().toLowerCase();
        assertTrue(markdown.contains("firecrawl") || markdown.contains("scrape") || markdown.contains("crawl"),
                "Content should mention Firecrawl features");
        
        // Check metadata
        String sourceUrl = doc.getMetadata().get("sourceURL").toString();
        assertTrue(sourceUrl.contains("firecrawl.dev"), "Source URL should be firecrawl.dev");
        
        // Display results
        System.out.println("\n✓ Successfully scraped Firecrawl.dev!");
        System.out.println("\nMetadata:");
        System.out.println("  Source URL: " + sourceUrl);
        if (doc.getMetadata().get("title") != null) {
            System.out.println("  Title: " + doc.getMetadata().get("title"));
        }
        System.out.println("  Status Code: " + doc.getMetadata().get("statusCode"));
        
        System.out.println("\nContent Stats:");
        System.out.println("  Markdown length: " + doc.getMarkdown().length() + " characters");
        System.out.println("  HTML length: " + doc.getHtml().length() + " characters");
        
        System.out.println("\nFirst 500 characters of markdown:");
        System.out.println("  " + doc.getMarkdown().substring(0, Math.min(500, doc.getMarkdown().length())).replace("\n", "\n  "));
        
        System.out.println("\n=== Live site test completed successfully! ===\n");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeFirecrawlPricing() {
        System.out.println("\n=== Testing Firecrawl Pricing Page ===\n");
        System.out.println("Scraping: https://firecrawl.dev/pricing");
        
        Document doc = client.scrape("https://firecrawl.dev/pricing",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        
        String markdown = doc.getMarkdown().toLowerCase();
        assertTrue(markdown.contains("pricing") || markdown.contains("plan") || markdown.contains("price"),
                "Pricing page should contain pricing information");
        
        System.out.println("✓ Successfully scraped pricing page!");
        System.out.println("  Content length: " + doc.getMarkdown().length() + " characters");
        System.out.println("  Source: " + doc.getMetadata().get("sourceURL"));
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeFirecrawlDocs() {
        System.out.println("\n=== Testing Firecrawl Documentation ===\n");
        System.out.println("Scraping: https://docs.firecrawl.dev");
        
        Document doc = client.scrape("https://docs.firecrawl.dev",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .waitFor(2000)  // Wait for docs to load
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        assertFalse(doc.getMarkdown().isEmpty(), "Markdown should not be empty");
        
        String markdown = doc.getMarkdown().toLowerCase();
        assertTrue(markdown.contains("document") || markdown.contains("api") || markdown.contains("firecrawl"),
                "Docs should contain documentation content");
        
        System.out.println("✓ Successfully scraped documentation!");
        System.out.println("  Content length: " + doc.getMarkdown().length() + " characters");
        System.out.println("  Source: " + doc.getMetadata().get("sourceURL"));
        
        System.out.println("\n=== All Firecrawl.dev tests passed! ===\n");
    }
}
