package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.models.Document;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * POST /v2/scrape error handling against a local mock HTTP server.
 */
class ScrapeErrorMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> responseBody = new AtomicReference<>();
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastMethod.set(exchange.getRequestMethod());
            lastPath.set(exchange.getRequestURI().getPath());
            byte[] bytes = responseBody.get().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();
        client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .apiUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .maxRetries(0)
                .build();
    }

    @AfterEach
    void teardown() {
        server.stop(0);
    }

    @Test
    void testScrapeThrowsOnSuccessFalse() {
        responseBody.set("{\"success\":false,\"code\":\"SCRAPE_DNS_RESOLUTION_ERROR\","
                + "\"error\":\"DNS resolution failed for hostname \\\"nonexistent.example\\\".\"}");

        FirecrawlException e = assertThrows(FirecrawlException.class,
                () -> client.scrape("https://nonexistent.example"));

        assertEquals("POST", lastMethod.get());
        assertEquals("/v2/scrape", lastPath.get());
        assertEquals(200, e.getStatusCode());
        assertEquals("SCRAPE_DNS_RESOLUTION_ERROR", e.getErrorCode());
        assertEquals("DNS resolution failed for hostname \"nonexistent.example\".", e.getMessage());
    }

    @Test
    void testScrapeReturnsDocumentOnSuccess() {
        responseBody.set("{\"success\":true,\"data\":{\"markdown\":\"# Hello\"}}");

        Document doc = client.scrape("https://example.com");

        assertEquals("POST", lastMethod.get());
        assertEquals("/v2/scrape", lastPath.get());
        assertEquals("# Hello", doc.getMarkdown());
    }
}
