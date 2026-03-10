package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.models.Document;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Scrape Endpoint Tests
 * 
 * Tests the scrape functionality of the Firecrawl Java SDK.
 * These tests require FIRECRAWL_API_KEY environment variable to be set.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.ScrapeTest"
 */
class ScrapeTest {

    private static FirecrawlClient client;

    @BeforeAll
    static void setup() {
        // Initialize client from environment variable
        String apiKey = System.getenv("FIRECRAWL_API_KEY");
        if (apiKey != null && !apiKey.isBlank()) {
            client = FirecrawlClient.fromEnv();
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeBasic() {
        // Test basic scraping with markdown format
        System.out.println("Testing basic scrape with markdown format...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        assertFalse(doc.getMarkdown().isEmpty(), "Markdown content should not be empty");
        
        System.out.println("✓ Basic scrape test passed");
        System.out.println("  Markdown length: " + doc.getMarkdown().length() + " characters");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeWithMultipleFormats() {
        // Test scraping with multiple formats
        System.out.println("Testing scrape with multiple formats (markdown + html)...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown", "html"))
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        assertNotNull(doc.getHtml(), "HTML content should not be null");
        assertFalse(doc.getMarkdown().isEmpty(), "Markdown should not be empty");
        assertFalse(doc.getHtml().isEmpty(), "HTML should not be empty");
        
        System.out.println("✓ Multiple formats test passed");
        System.out.println("  Markdown length: " + doc.getMarkdown().length());
        System.out.println("  HTML length: " + doc.getHtml().length());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeWithMetadata() {
        // Test that metadata is properly extracted
        System.out.println("Testing scrape with metadata extraction...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .build());

        // Assertions
        assertNotNull(doc.getMetadata(), "Metadata should not be null");
        assertNotNull(doc.getMetadata().get("sourceURL"), "Source URL should be in metadata");
        assertTrue(doc.getMetadata().get("sourceURL").toString().contains("example.com"),
                "Source URL should contain example.com");
        
        System.out.println("✓ Metadata extraction test passed");
        System.out.println("  Source URL: " + doc.getMetadata().get("sourceURL"));
        if (doc.getMetadata().get("title") != null) {
            System.out.println("  Title: " + doc.getMetadata().get("title"));
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeWithOnlyMainContent() {
        // Test scraping with onlyMainContent option
        System.out.println("Testing scrape with onlyMainContent option...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .onlyMainContent(true)
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown content should not be null");
        assertFalse(doc.getMarkdown().isEmpty(), "Markdown should not be empty");
        
        System.out.println("✓ Only main content test passed");
        System.out.println("  Content length: " + doc.getMarkdown().length());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeWithTimeout() {
        // Test scraping with custom timeout
        System.out.println("Testing scrape with custom timeout...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .timeout(10000)  // 10 seconds
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown should not be null");
        
        System.out.println("✓ Timeout configuration test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeInvalidUrl() {
        // Test that invalid URLs are handled properly
        System.out.println("Testing scrape with invalid URL...");
        
        assertThrows(FirecrawlException.class, () -> {
            client.scrape("not-a-valid-url",
                    ScrapeOptions.builder()
                            .formats(List.of("markdown"))
                            .build());
        }, "Should throw FirecrawlException for invalid URL");
        
        System.out.println("✓ Invalid URL handling test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeWithWaitFor() {
        // Test scraping with waitFor option (useful for dynamic content)
        System.out.println("Testing scrape with waitFor option...");
        
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .waitFor(1000)  // Wait 1 second for page to load
                        .build());

        // Assertions
        assertNotNull(doc, "Document should not be null");
        assertNotNull(doc.getMarkdown(), "Markdown should not be null");
        
        System.out.println("✓ WaitFor option test passed");
    }
}
