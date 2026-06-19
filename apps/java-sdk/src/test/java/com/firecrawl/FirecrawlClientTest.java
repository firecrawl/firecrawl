package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.models.*;
import okhttp3.OkHttpClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration tests for the Firecrawl Java SDK.
 *
 * <p>These tests require a valid FIRECRAWL_API_KEY environment variable.
 * Run with: FIRECRAWL_API_KEY=fc-xxx ./gradlew test
 */
class FirecrawlClientTest {

    @Test
    void testBuilderRequiresApiKey() {
        assertThrows(FirecrawlException.class, () ->
                FirecrawlClient.builder().apiKey("").build()
        );
    }

    @Test
    void testBuilderRejectsExplicitNullApiKey() {
        assertThrows(FirecrawlException.class, () ->
                FirecrawlClient.builder().apiKey(null).build()
        );
    }

    @Test
    void testBuilderAcceptsApiKey() {
        // Should not throw — just validates construction
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertNotNull(client);
    }

    @Test
    void testBuilderAcceptsCustomHttpClient() {
        OkHttpClient custom = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build();

        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .httpClient(custom)
                .build();
        assertNotNull(client);
    }

    @Test
    void testScrapeOptionsBuilder() {
        QueryFormat queryFormat = QueryFormat.builder()
                .prompt("What is Firecrawl?")
                .mode(QueryFormat.Mode.DIRECT_QUOTE)
                .build();

        ScrapeOptions options = ScrapeOptions.builder()
                .formats(List.of("markdown", "html", "video", queryFormat))
                .onlyMainContent(true)
                .timeout(30000)
                .mobile(false)
                .redactPII(true)
                .build();

        assertEquals(List.of("markdown", "html", "video", queryFormat), options.getFormats());
        assertEquals("query", queryFormat.getType());
        assertEquals(QueryFormat.Mode.DIRECT_QUOTE, queryFormat.getMode());
        assertTrue(options.getOnlyMainContent());
        assertEquals(30000, options.getTimeout());
        assertFalse(options.getMobile());
        assertTrue(options.getRedactPII());
    }

    @Test
    void testQuestionAndHighlightsFormats() {
        QuestionFormat questionFormat = QuestionFormat.builder()
                .question("What is Firecrawl?")
                .build();
        HighlightsFormat highlightsFormat = HighlightsFormat.builder()
                .query("What is Firecrawl?")
                .build();

        ScrapeOptions options = ScrapeOptions.builder()
                .formats(List.of(questionFormat, highlightsFormat))
                .build();

        assertEquals(List.of(questionFormat, highlightsFormat), options.getFormats());
        assertEquals("question", questionFormat.getType());
        assertEquals("What is Firecrawl?", questionFormat.getQuestion());
        assertEquals("highlights", highlightsFormat.getType());
        assertEquals("What is Firecrawl?", highlightsFormat.getQuery());
    }

    @Test
    void testCrawlOptionsBuilder() {
        CrawlOptions options = CrawlOptions.builder()
                .limit(100)
                .maxDiscoveryDepth(3)
                .sitemap("include")
                .excludePaths(List.of("/admin/*"))
                .build();

        assertEquals(100, options.getLimit());
        assertEquals(3, options.getMaxDiscoveryDepth());
        assertEquals("include", options.getSitemap());
        assertEquals(List.of("/admin/*"), options.getExcludePaths());
    }

    @Test
    void testAgentOptionsRequiresPrompt() {
        assertThrows(IllegalArgumentException.class, () ->
                AgentOptions.builder().build()
        );
    }

    @Test
    void testWebhookConfigRequiresUrl() {
        assertThrows(IllegalArgumentException.class, () ->
                WebhookConfig.builder().build()
        );
    }

    @Test
    void testScrapeOptionsToBuilder() {
        ScrapeOptions original = ScrapeOptions.builder()
                .formats(List.of("markdown"))
                .timeout(5000)
                .redactPII(true)
                .build();

        ScrapeOptions modified = original.toBuilder()
                .timeout(10000)
                .build();

        assertEquals(5000, original.getTimeout());
        assertEquals(10000, modified.getTimeout());
        assertEquals(List.of("markdown"), modified.getFormats());
        assertTrue(modified.getRedactPII());
    }

    @Test
    void testBrowserExecuteRequiresSessionId() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.browserExecute(null, "echo test")
        );
    }

    @Test
    void testInteractRequiresJobId() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.interact(null, "console.log('hi')")
        );
    }

    @Test
    void testInteractRequiresCode() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.interact("job-id", null)
        );
    }

    @Test
    void testBrowserDeleteRequiresSessionId() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.deleteBrowser(null)
        );
    }

    @Test
    void testStopInteractiveBrowserRequiresJobId() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.stopInteractiveBrowser(null)
        );
    }

    @Test
    void testParseFileBuilder() {
        ParseFile file = ParseFile.builder()
                .filename("upload.html")
                .content("<html><body>hello</body></html>".getBytes(StandardCharsets.UTF_8))
                .contentType("text/html")
                .build();

        assertEquals("upload.html", file.getFilename());
        assertEquals("text/html", file.getContentType());
        assertTrue(file.getContent().length > 0);
        byte[] firstRead = file.getContent();
        firstRead[0] = 'X';
        assertNotEquals(firstRead[0], file.getContent()[0]);
    }

    @Test
    void testParseRequiresFile() {
        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();
        assertThrows(NullPointerException.class, () ->
                client.parse(null)
        );
    }

    @Test
    void testParseOptionsRejectsChangeTrackingFormat() {
        assertThrows(IllegalArgumentException.class, () ->
                ParseOptions.builder()
                        .formats(List.of("markdown", "changeTracking"))
                        .build()
        );
    }

    @Test
    void testParseOptionsRejectsVideoFormat() {
        assertThrows(IllegalArgumentException.class, () ->
                ParseOptions.builder()
                        .formats(List.of("video"))
                        .build()
        );
    }

    @Test
    void testParseOptionsRejectsProductFormat() {
        assertThrows(IllegalArgumentException.class, () ->
                ParseOptions.builder()
                        .formats(List.of("product"))
                        .build()
        );
    }

    @Test
    void testParseOptionsRejectsMenuFormat() {
        assertThrows(IllegalArgumentException.class, () ->
                ParseOptions.builder()
                        .formats(List.of("menu"))
                        .build()
        );
    }

    @Test
    void testDocumentDeserializesMenu() throws Exception {
        String json = "{\"menu\":{"
                + "\"isMenu\":true,"
                + "\"confidence\":0.9,"
                + "\"currency\":\"USD\","
                + "\"sourceUrl\":\"https://example.com/menu\","
                + "\"merchant\":{\"name\":\"Joe's Diner\",\"type\":\"restaurant\",\"location\":{\"city\":\"NYC\"}},"
                + "\"sections\":[{"
                + "\"id\":\"sec-1\",\"name\":\"Mains\",\"description\":\"Hearty plates\",\"items\":[{"
                + "\"id\":\"item-1\",\"name\":\"Burger\",\"description\":\"Beef burger\","
                + "\"images\":[{\"url\":\"https://example.com/burger.jpg\",\"alt\":\"Burger\"}],"
                + "\"price\":{\"amount\":12.5,\"currency\":\"USD\",\"formatted\":\"$12.50\"},"
                + "\"availability\":{\"inStock\":true,\"text\":\"Available\"},"
                + "\"dietary\":[\"halal\"],\"calories\":800,"
                + "\"optionGroups\":[{\"name\":\"Cheese\"}],"
                + "\"identifiers\":{\"merchantItemId\":\"sku-99\"},"
                + "\"url\":\"https://example.com/menu#burger\","
                + "\"sourceUrl\":\"https://example.com/menu\""
                + "}]}]}}";

        com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        Document doc = mapper.readValue(json, Document.class);

        Menu menu = doc.getMenu();
        assertNotNull(menu);
        assertTrue(menu.isMenu());
        assertEquals(0.9, menu.getConfidence());
        assertEquals("USD", menu.getCurrency());
        assertEquals("https://example.com/menu", menu.getSourceUrl());
        assertEquals("Joe's Diner", menu.getMerchant().getName());
        assertEquals("restaurant", menu.getMerchant().getType());

        assertEquals(1, menu.getSections().size());
        MenuSection section = menu.getSections().get(0);
        assertEquals("sec-1", section.getId());
        assertEquals("Mains", section.getName());

        MenuItem item = section.getItems().get(0);
        assertEquals("Burger", item.getName());
        assertEquals(12.5, item.getPrice().getAmount());
        assertTrue(item.getAvailability().isInStock());
        assertEquals(List.of("halal"), item.getDietary());
        assertEquals(800.0, item.getCalories());
        assertEquals("https://example.com/burger.jpg", item.getImages().get(0).getUrl());
        assertEquals("sku-99", item.getIdentifiers().getMerchantItemId());
        assertEquals("https://example.com/menu", item.getSourceUrl());
    }

    @Test
    void testParseOptionsBuilderSupportsRedactPII() {
        ParseOptions options = ParseOptions.builder()
                .formats(List.of("markdown"))
                .redactPII(true)
                .build();

        assertTrue(options.getRedactPII());
    }

    // ================================================================
    // E2E TESTS (require FIRECRAWL_API_KEY)
    // ================================================================

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testScrapeE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        Document doc = client.scrape("https://example.com",
                ScrapeOptions.builder()
                        .formats(List.of("markdown"))
                        .build());

        assertNotNull(doc);
        assertNotNull(doc.getMarkdown());
        assertFalse(doc.getMarkdown().isEmpty());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testMapE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        MapData data = client.map("https://example.com",
                MapOptions.builder()
                        .limit(10)
                        .build());

        assertNotNull(data);
        assertNotNull(data.getLinks());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCrawlE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        CrawlJob job = client.crawl("https://example.com",
                CrawlOptions.builder()
                        .limit(3)
                        .build(),
                2, 60);

        assertNotNull(job);
        assertEquals("completed", job.getStatus());
        assertNotNull(job.getData());
        assertFalse(job.getData().isEmpty());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testSearchE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        SearchData data = client.search("firecrawl web scraping",
                SearchOptions.builder()
                        .limit(5)
                        .build());

        assertNotNull(data);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testConcurrencyE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        ConcurrencyCheck check = client.getConcurrency();

        assertNotNull(check);
        assertTrue(check.getMaxConcurrency() > 0);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCreditUsageE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        CreditUsage usage = client.getCreditUsage();

        assertNotNull(usage);
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testParseE2E() {
        FirecrawlClient client = FirecrawlClient.fromEnv();
        ParseFile file = ParseFile.builder()
                .filename("java-parse-e2e.html")
                .content("<!DOCTYPE html><html><body><h1>Java SDK Parse E2E</h1></body></html>".getBytes(StandardCharsets.UTF_8))
                .contentType("text/html")
                .build();

        Document doc = client.parse(file, ParseOptions.builder()
                .formats(List.of("markdown"))
                .build());

        assertNotNull(doc);
        assertNotNull(doc.getMarkdown());
        assertFalse(doc.getMarkdown().isEmpty());
        assertTrue(doc.getMarkdown().contains("Java SDK Parse E2E"));
    }
}
