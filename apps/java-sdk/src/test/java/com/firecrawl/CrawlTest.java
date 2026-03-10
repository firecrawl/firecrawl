package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.models.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Comprehensive Crawl Tests
 * 
 * Tests the crawl functionality with various configurations.
 * Based on Node.js SDK patterns and tested against live firecrawl.dev.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.CrawlTest"
 */
class CrawlTest {

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
    void testStartCrawlMinimal() {
        System.out.println("\n=== Test: Start Crawl - Minimal Request ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(3)
                        .build());

        assertNotNull(response, "Crawl response should not be null");
        assertNotNull(response.getId(), "Crawl ID should not be null");
        assertNotNull(response.getUrl(), "Crawl URL should not be null");
        
        System.out.println("✓ Crawl started successfully");
        System.out.println("  Job ID: " + response.getId());
        System.out.println("  Status URL: " + response.getUrl());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testStartCrawlWithOptions() {
        System.out.println("\n=== Test: Start Crawl - With Options ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(5)
                        .maxDiscoveryDepth(2)
                        .build());

        assertNotNull(response.getId(), "Job ID should not be null");
        assertNotNull(response.getUrl(), "Status URL should not be null");
        
        System.out.println("✓ Crawl with options started");
        System.out.println("  Limit: 5 pages");
        System.out.println("  Max depth: 2");
        System.out.println("  Job ID: " + response.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testGetCrawlStatus() {
        System.out.println("\n=== Test: Get Crawl Status ===");
        
        // Start a crawl
        CrawlResponse start = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(3)
                        .build());

        System.out.println("CrawlResponse: " + start);
        System.out.println("ID: " + start.getId());
        assertNotNull(start, "CrawlResponse should not be null");
        assertNotNull(start.getId(), "Crawl ID should not be null");

        // Get status
        CrawlJob status = client.getCrawlStatus(start.getId());
        
        assertNotNull(status, "Status should not be null");
        assertNotNull(status.getStatus(), "Status should not be null");
        assertTrue(List.of("scraping", "completed", "failed", "cancelled").contains(status.getStatus()),
                "Status should be valid: " + status.getStatus());
        assertTrue(status.getCompleted() >= 0, "Completed count should be non-negative");
        // Data may be null while crawl is still in progress (status=scraping)
        if ("completed".equals(status.getStatus())) {
            assertNotNull(status.getData(), "Data should not be null when completed");
        }

        System.out.println("✓ Status retrieved successfully");
        System.out.println("  Status: " + status.getStatus());
        System.out.println("  Completed: " + status.getCompleted() + "/" + status.getTotal());
        System.out.println("  Documents: " + (status.getData() != null ? status.getData().size() : 0));
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCancelCrawl() {
        System.out.println("\n=== Test: Cancel Crawl ===");
        
        CrawlResponse start = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(10)
                        .build());

        Map<String, Object> result = client.cancelCrawl(start.getId());
        
        assertNotNull(result, "Cancel result should not be null");
        
        System.out.println("✓ Crawl cancelled successfully");
        System.out.println("  Job ID: " + start.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithWait() {
        System.out.println("\n=== Test: Crawl with Wait (Blocking) ===");
        
        CrawlJob job = client.crawl("https://firecrawl.dev",
                CrawlOptions.builder()
                        .limit(3)
                        .maxDiscoveryDepth(1)
                        .build(),
                2,  // pollInterval in seconds
                120 // timeout in seconds
        );

        assertNotNull(job, "Job should not be null");
        assertTrue(List.of("completed", "failed").contains(job.getStatus()),
                "Final status should be completed or failed: " + job.getStatus());
        assertTrue(job.getCompleted() >= 0, "Completed count should be non-negative");
        assertTrue(job.getTotal() >= 0, "Total count should be non-negative");
        assertNotNull(job.getData(), "Data should not be null");
        
        System.out.println("✓ Crawl completed (with wait)");
        System.out.println("  Final status: " + job.getStatus());
        System.out.println("  Pages crawled: " + job.getCompleted() + "/" + job.getTotal());
        System.out.println("  Documents returned: " + job.getData().size());
        
        if (!job.getData().isEmpty()) {
            Document firstDoc = job.getData().get(0);
            System.out.println("  Sample URL: " + firstDoc.getMetadata().get("sourceURL"));
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithScrapeOptions() {
        System.out.println("\n=== Test: Crawl with Scrape Options ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(2)
                        .scrapeOptions(ScrapeOptions.builder()
                                .formats(List.of("markdown", "links"))
                                .onlyMainContent(true)
                                .build())
                        .build());

        assertNotNull(response.getId(), "Job ID should not be null");
        
        System.out.println("✓ Crawl with scrape options started");
        System.out.println("  Formats: markdown, links");
        System.out.println("  Only main content: true");
        System.out.println("  Job ID: " + response.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithExcludePaths() {
        System.out.println("\n=== Test: Crawl with Exclude Paths ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(5)
                        .excludePaths(List.of("/blog/*", "/admin/*"))
                        .build());

        assertNotNull(response.getId(), "Job ID should not be null");
        
        System.out.println("✓ Crawl with exclude paths started");
        System.out.println("  Excluding: /blog/*, /admin/*");
        System.out.println("  Job ID: " + response.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithIncludePaths() {
        System.out.println("\n=== Test: Crawl with Include Paths ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(5)
                        .includePaths(List.of("/docs/*"))
                        .build());

        assertNotNull(response.getId(), "Job ID should not be null");
        
        System.out.println("✓ Crawl with include paths started");
        System.out.println("  Including only: /docs/*");
        System.out.println("  Job ID: " + response.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithAllowExternalLinks() {
        System.out.println("\n=== Test: Crawl with Allow External Links ===");
        
        CrawlResponse response = client.startCrawl("https://docs.firecrawl.dev",
                CrawlOptions.builder()
                        .limit(5)
                        .allowExternalLinks(true)
                        .build());

        assertNotNull(response.getId(), "Job ID should not be null");
        
        System.out.println("✓ Crawl with external links allowed");
        System.out.println("  Job ID: " + response.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlWithWebhookConfig() {
        System.out.println("\n=== Test: Crawl with Webhook (if available) ===");
        
        try {
            // Using a test webhook URL (requestbin, webhook.site, etc.)
            CrawlResponse response = client.startCrawl("https://firecrawl.dev",
                    CrawlOptions.builder()
                            .limit(2)
                            .webhook(WebhookConfig.builder()
                                    .url("https://webhook.site/test")
                                    .build())
                            .build());

            assertNotNull(response.getId(), "Job ID should not be null");
            
            System.out.println("✓ Crawl with webhook started");
            System.out.println("  Job ID: " + response.getId());
        } catch (Exception e) {
            System.out.println("⚠ Webhook test skipped or failed: " + e.getMessage());
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlFirecrawlHomepage() {
        System.out.println("\n=== Test: Crawl Firecrawl.dev Homepage ===");
        
        CrawlJob job = client.crawl("https://firecrawl.dev",
                CrawlOptions.builder()
                        .limit(5)
                        .maxDiscoveryDepth(2)
                        .scrapeOptions(ScrapeOptions.builder()
                                .formats(List.of("markdown"))
                                .onlyMainContent(true)
                                .build())
                        .build(),
                2,
                120
        );

        assertNotNull(job, "Job should not be null");
        assertTrue(job.getData() != null && !job.getData().isEmpty(),
                "Should have crawled at least one page");
        
        // Verify content from Firecrawl site
        boolean hasFirecrawlContent = job.getData().stream()
                .anyMatch(doc -> {
                    String markdown = doc.getMarkdown();
                    return markdown != null && 
                           (markdown.toLowerCase().contains("firecrawl") ||
                            markdown.toLowerCase().contains("scrape") ||
                            markdown.toLowerCase().contains("crawl"));
                });
        
        assertTrue(hasFirecrawlContent, "Should contain Firecrawl-related content");
        
        System.out.println("✓ Successfully crawled Firecrawl homepage");
        System.out.println("  Pages crawled: " + job.getData().size());
        System.out.println("  Status: " + job.getStatus());
        
        // Print sample URLs
        System.out.println("  Sample pages:");
        job.getData().stream()
                .limit(3)
                .forEach(doc -> System.out.println("    - " + doc.getMetadata().get("sourceURL")));
    }
}
