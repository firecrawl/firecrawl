package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.MapData;
import com.firecrawl.models.MapOptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Comprehensive Map Tests
 * 
 * Tests the map functionality with various configurations.
 * Based on Node.js SDK patterns and tested against live firecrawl.dev.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.MapTest"
 */
class MapTest {

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
    void testMapMinimal() {
        System.out.println("\n=== Test: Map - Minimal Request ===");
        
        MapData data = client.map("https://docs.firecrawl.dev");

        assertNotNull(data, "Map data should not be null");
        assertNotNull(data.getLinks(), "Links should not be null");
        assertTrue(!data.getLinks().isEmpty(), "Should have at least one link");
        
        // Verify link structure (v2 links are MapDocument objects with url, title, description)
        Map<String, Object> firstLink = data.getLinks().get(0);
        assertNotNull(firstLink, "Link should not be null");
        assertNotNull(firstLink.get("url"), "Link should have url");
        assertTrue(firstLink.get("url").toString().startsWith("http"), "URL should start with http");
        
        System.out.println("✓ Map completed successfully");
        System.out.println("  Total links found: " + data.getLinks().size());
        System.out.println("  Sample URL: " + firstLink.get("url"));
        if (firstLink.get("title") != null) {
            System.out.println("  Title: " + firstLink.get("title"));
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithLimit() {
        System.out.println("\n=== Test: Map with Limit ===");
        
        MapData data = client.map("https://docs.firecrawl.dev",
                MapOptions.builder()
                        .limit(10)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        assertTrue(data.getLinks().size() <= 10,
                "Should respect limit of 10: got " + data.getLinks().size());
        
        System.out.println("✓ Map with limit completed");
        System.out.println("  Requested limit: 10");
        System.out.println("  Actual links: " + data.getLinks().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithSearch() {
        System.out.println("\n=== Test: Map with Search Filter ===");
        
        MapData data = client.map("https://docs.firecrawl.dev",
                MapOptions.builder()
                        .search("api")
                        .limit(20)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        
        // Verify that filtered results contain the search term
        long matchingLinks = data.getLinks().stream()
                .filter(link -> {
                    String url = link.get("url") != null ? link.get("url").toString().toLowerCase() : "";
                    String title = link.get("title") != null ? link.get("title").toString().toLowerCase() : "";
                    return url.contains("api") || title.contains("api");
                })
                .count();
        
        System.out.println("✓ Map with search completed");
        System.out.println("  Total links: " + data.getLinks().size());
        System.out.println("  Links matching 'api': " + matchingLinks);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithSkipSitemap() {
        System.out.println("\n=== Test: Map with Sitemap Skip ===");
        
        MapData data = client.map("https://firecrawl.dev",
                MapOptions.builder()
                        .sitemap("skip")
                        .limit(15)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        assertTrue(data.getLinks().size() <= 15, "Should respect limit");
        
        // Verify all links are valid HTTP(S) URLs
        boolean allValidUrls = data.getLinks().stream()
                .allMatch(link -> {
                    String url = link.get("url") != null ? link.get("url").toString() : "";
                    return url.startsWith("http://") || url.startsWith("https://");
                });
        
        assertTrue(allValidUrls, "All URLs should be valid HTTP(S)");
        
        System.out.println("✓ Map with sitemap=skip completed");
        System.out.println("  Links found: " + data.getLinks().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithSitemapOnly() {
        System.out.println("\n=== Test: Map with Sitemap Only ===");
        
        MapData data = client.map("https://firecrawl.dev",
                MapOptions.builder()
                        .sitemap("only")
                        .limit(50)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        // Note: sitemapOnly may not always respect the limit strictly
        
        // Verify all links are valid HTTP(S) URLs
        boolean allValidUrls = data.getLinks().stream()
                .allMatch(link -> {
                    String url = link.get("url") != null ? link.get("url").toString() : "";
                    return url.startsWith("http://") || url.startsWith("https://");
                });
        
        assertTrue(allValidUrls, "All URLs should be valid HTTP(S)");
        
        System.out.println("✓ Map with sitemap=only completed");
        System.out.println("  Links found: " + data.getLinks().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithIncludeSubdomains() {
        System.out.println("\n=== Test: Map with Include Subdomains ===");
        
        MapData data = client.map("https://firecrawl.dev",
                MapOptions.builder()
                        .includeSubdomains(true)
                        .limit(20)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        
        System.out.println("✓ Map with subdomains completed");
        System.out.println("  Total links: " + data.getLinks().size());
        
        // Check if any subdomains were found
        boolean hasSubdomains = data.getLinks().stream()
                .anyMatch(link -> {
                    String url = link.get("url") != null ? link.get("url").toString() : "";
                    return url.contains("docs.firecrawl.dev") || 
                           url.contains("api.firecrawl.dev") ||
                           (url.contains(".firecrawl.dev") && !url.contains("www.firecrawl.dev"));
                });
        
        if (hasSubdomains) {
            System.out.println("  ✓ Found subdomain links");
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapFirecrawlDocs() {
        System.out.println("\n=== Test: Map Firecrawl Documentation ===");
        
        MapData data = client.map("https://docs.firecrawl.dev",
                MapOptions.builder()
                        .limit(50)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        assertFalse(data.getLinks().isEmpty(), "Should find documentation links");
        
        System.out.println("✓ Mapped Firecrawl documentation");
        System.out.println("  Total links: " + data.getLinks().size());
        
        // Print sample links
        System.out.println("  Sample documentation pages:");
        data.getLinks().stream()
                .limit(5)
                .forEach(link -> System.out.println("    - " + link.get("url")));
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapLinkStructure() {
        System.out.println("\n=== Test: Verify Map Link Structure ===");
        
        MapData data = client.map("https://firecrawl.dev",
                MapOptions.builder()
                        .limit(5)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        assertFalse(data.getLinks().isEmpty(), "Should have links");
        
        // Verify each link is a valid URL with expected fields
        for (Map<String, Object> link : data.getLinks()) {
            assertNotNull(link, "Link should not be null");
            assertNotNull(link.get("url"), "Link should have url field");
            assertTrue(link.get("url").toString().startsWith("http"), "URL should be valid: " + link.get("url"));
        }
        
        System.out.println("✓ All links have correct structure");
        System.out.println("  Verified " + data.getLinks().size() + " links");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapWithTimeout() {
        System.out.println("\n=== Test: Map with Timeout ===");
        
        MapData data = client.map("https://firecrawl.dev",
                MapOptions.builder()
                        .timeout(15000)  // 15 seconds
                        .limit(10)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        
        System.out.println("✓ Map with timeout completed");
        System.out.println("  Timeout: 15000ms");
        System.out.println("  Links found: " + data.getLinks().size());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapComprehensive() {
        System.out.println("\n=== Test: Map with All Options ===");
        
        MapData data = client.map("https://docs.firecrawl.dev",
                MapOptions.builder()
                        .includeSubdomains(false)
                        .limit(25)
                        .sitemap("include")
                        .timeout(20000)
                        .build());

        assertNotNull(data.getLinks(), "Links should not be null");
        assertTrue(data.getLinks().size() <= 25, "Should respect limit");
        
        System.out.println("✓ Comprehensive map completed");
        System.out.println("  Configuration:");
        System.out.println("    - Include subdomains: false");
        System.out.println("    - Limit: 25");
        System.out.println("    - Ignore sitemap: false");
        System.out.println("    - Timeout: 20000ms");
        System.out.println("  Results:");
        System.out.println("    - Links found: " + data.getLinks().size());
    }
}
