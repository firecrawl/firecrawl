package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Comprehensive Search Tests
 * 
 * Tests the search functionality with various configurations.
 * Based on Node.js SDK patterns and tested against live firecrawl.dev.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.SearchTest"
 */
class SearchTest {

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
    void testSearchMinimal() {
        System.out.println("\n=== Test: Search - Minimal Request ===");
        
        SearchData results = client.search("What is Firecrawl?");

        assertNotNull(results, "Search results should not be null");
        assertNotNull(results.getWeb(), "Web results should not be null");
        assertTrue(!results.getWeb().isEmpty(), "Should have at least one web result");
        
        // Verify result structure
        Map<String, Object> firstResult = results.getWeb().get(0);
        assertNotNull(firstResult.get("url"), "Result should have URL");
        assertTrue(firstResult.get("url").toString().startsWith("http"),
                "URL should be valid");
        
        System.out.println("✓ Search completed successfully");
        System.out.println("  Web results: " + results.getWeb().size());
        System.out.println("  Sample result: " + firstResult.get("url"));
        if (firstResult.get("title") != null) {
            System.out.println("  Title: " + firstResult.get("title"));
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchWithLimit() {
        System.out.println("\n=== Test: Search with Limit ===");
        
        SearchData results = client.search("artificial intelligence",
                SearchOptions.builder()
                        .limit(5)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        assertTrue(results.getWeb().size() <= 5,
                "Should respect limit of 5: got " + results.getWeb().size());
        
        System.out.println("✓ Search with limit completed");
        System.out.println("  Requested limit: 5");
        System.out.println("  Actual results: " + results.getWeb().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchWithMultipleSources() {
        System.out.println("\n=== Test: Search with Multiple Sources ===");
        
        SearchData results = client.search("Firecrawl web scraping",
                SearchOptions.builder()
                        .sources(List.of("web", "news"))
                        .limit(3)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        assertTrue(results.getWeb().size() <= 3, "Web results should respect limit");
        
        System.out.println("✓ Multi-source search completed");
        System.out.println("  Web results: " + results.getWeb().size());
        if (results.getNews() != null) {
            System.out.println("  News results: " + results.getNews().size());
        } else {
            System.out.println("  News results: 0");
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchResultStructure() {
        System.out.println("\n=== Test: Verify Search Result Structure ===");
        
        SearchData results = client.search("test query",
                SearchOptions.builder()
                        .limit(1)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        
        if (!results.getWeb().isEmpty()) {
            Map<String, Object> result = results.getWeb().get(0);
            
            assertNotNull(result.get("url"), "Result must have URL");
            assertTrue(result.get("url") instanceof String, "URL should be string");
            assertTrue(result.get("url").toString().startsWith("http"),
                    "URL should be valid");
            
            // Title and description may be null but if present should be strings
            if (result.get("title") != null) {
                assertTrue(result.get("title") instanceof String,
                        "Title should be string");
            }
            if (result.get("description") != null) {
                assertTrue(result.get("description") instanceof String,
                        "Description should be string");
            }
            
            System.out.println("✓ Result structure verified");
            System.out.println("  URL: ✓");
            System.out.println("  Title: " + (result.get("title") != null ? "✓" : "null"));
            System.out.println("  Description: " + (result.get("description") != null ? "✓" : "null"));
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchWithLocation() {
        System.out.println("\n=== Test: Search with Location ===");
        
        SearchData results = client.search("restaurants near me",
                SearchOptions.builder()
                        .location("US")
                        .limit(5)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        
        System.out.println("✓ Search with location completed");
        System.out.println("  Location: US");
        System.out.println("  Results: " + results.getWeb().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchWithTimeFilter() {
        System.out.println("\n=== Test: Search with Time Filter ===");
        
        SearchData results = client.search("latest AI news",
                SearchOptions.builder()
                        .tbs("qdr:m")  // Past month
                        .limit(5)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        
        System.out.println("✓ Search with time filter completed");
        System.out.println("  Time filter: Past month (qdr:m)");
        System.out.println("  Results: " + results.getWeb().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchWithScrapeOptions() {
        System.out.println("\n=== Test: Search with Scrape Options ===");
        
        SearchData results = client.search("Firecrawl documentation",
                SearchOptions.builder()
                        .limit(2)
                        .scrapeOptions(ScrapeOptions.builder()
                                .formats(List.of("markdown"))
                                .onlyMainContent(true)
                                .build())
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");

        // When scrapeOptions with markdown format are provided, results should include markdown content
        if (!results.getWeb().isEmpty()) {
            Map<String, Object> first = results.getWeb().get(0);
            Object markdown = first.get("markdown");
            assertNotNull(markdown, "Scraped result should contain markdown content when formats=[markdown]");
            assertFalse(markdown.toString().isEmpty(), "Markdown content should not be empty");
        }

        System.out.println("✓ Search with scrape options completed");
        System.out.println("  Results: " + results.getWeb().size());
        System.out.println("  Scrape formats: markdown");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchFirecrawlSpecific() {
        System.out.println("\n=== Test: Search for Firecrawl ===");
        
        SearchData results = client.search("Firecrawl web scraping API",
                SearchOptions.builder()
                        .limit(10)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        assertFalse(results.getWeb().isEmpty(), "Should find Firecrawl results");
        
        // Verify results contain Firecrawl-related content
        boolean hasFirecrawlContent = results.getWeb().stream()
                .anyMatch(result -> {
                    String url = result.get("url").toString().toLowerCase();
                    String title = result.get("title") != null ?
                            result.get("title").toString().toLowerCase() : "";
                    String desc = result.get("description") != null ?
                            result.get("description").toString().toLowerCase() : "";
                    
                    return url.contains("firecrawl") ||
                           title.contains("firecrawl") ||
                           desc.contains("firecrawl");
                });
        
        assertTrue(hasFirecrawlContent, "Results should mention Firecrawl");
        
        System.out.println("✓ Firecrawl search completed");
        System.out.println("  Total results: " + results.getWeb().size());
        System.out.println("  Results mentioning Firecrawl: ✓");
        
        // Print sample results
        System.out.println("  Sample results:");
        results.getWeb().stream()
                .limit(3)
                .forEach(result -> {
                    System.out.println("    - " + result.get("title"));
                    System.out.println("      " + result.get("url"));
                });
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchComprehensive() {
        System.out.println("\n=== Test: Search with All Options ===");
        
        SearchData results = client.search("web scraping tools",
                SearchOptions.builder()
                        .sources(List.of("web"))
                        .limit(5)
                        .tbs("qdr:y")  // Past year
                        .location("US")
                        .timeout(30000)
                        .scrapeOptions(ScrapeOptions.builder()
                                .formats(List.of("markdown"))
                                .onlyMainContent(true)
                                .waitFor(1000)
                                .build())
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        assertTrue(results.getWeb().size() <= 5, "Should respect limit");
        
        System.out.println("✓ Comprehensive search completed");
        System.out.println("  Configuration:");
        System.out.println("    - Sources: web");
        System.out.println("    - Limit: 5");
        System.out.println("    - Time filter: Past year");
        System.out.println("    - Location: US");
        System.out.println("    - Timeout: 30000ms");
        System.out.println("    - Scrape: markdown, main content only");
        System.out.println("  Results:");
        System.out.println("    - Web results: " + results.getWeb().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchContentVerification() {
        System.out.println("\n=== Test: Search Content Verification ===");
        
        SearchData results = client.search("Python programming language",
                SearchOptions.builder()
                        .limit(5)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        assertFalse(results.getWeb().isEmpty(), "Should have results");
        
        // Verify results are relevant to the query
        boolean hasRelevantContent = results.getWeb().stream()
                .anyMatch(result -> {
                    String text = String.format("%s %s %s",
                            result.get("url"),
                            result.get("title"),
                            result.get("description")
                    ).toLowerCase();
                    return text.contains("python");
                });
        
        assertTrue(hasRelevantContent, "Results should be relevant to query");
        
        System.out.println("✓ Content verification passed");
        System.out.println("  Query: Python programming language");
        System.out.println("  Relevant results found: ✓");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchIgnoreInvalidURLs() {
        System.out.println("\n=== Test: Search with Ignore Invalid URLs ===");
        
        SearchData results = client.search("technology news",
                SearchOptions.builder()
                        .limit(5)
                        .ignoreInvalidURLs(true)
                        .build());

        assertNotNull(results.getWeb(), "Web results should not be null");
        
        // Verify all URLs are valid
        boolean allValidUrls = results.getWeb().stream()
                .allMatch(result -> {
                    String url = result.get("url").toString();
                    return url.startsWith("http://") || url.startsWith("https://");
                });
        
        assertTrue(allValidUrls, "All URLs should be valid HTTP(S)");
        
        System.out.println("✓ Search with URL validation completed");
        System.out.println("  Results: " + results.getWeb().size());
        System.out.println("  All URLs valid: ✓");
    }
}
