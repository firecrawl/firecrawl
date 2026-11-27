package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.BatchScrapeOptions;
import com.firecrawl.models.ScrapeOptions;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Checks that job-starting calls tag their request bodies with the SDK origin.
 */
class JobOriginMockTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private HttpServer server;
    private FirecrawlClient client;
    private final Map<String, String> bodies = new ConcurrentHashMap<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            bodies.put(path, new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            String response = path.equals("/v2/map")
                    ? "{\"success\":true,\"links\":[]}"
                    : "{\"success\":true,\"id\":\"job-1\",\"url\":\"https://api.firecrawl.dev/job-1\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
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

    private JsonNode body(String path) throws IOException {
        String raw = bodies.get(path);
        assertNotNull(raw, "no request to " + path);
        return MAPPER.readTree(raw);
    }

    @Test
    void startCrawlBatchScrapeAndMapSendSdkOrigin() throws IOException {
        client.startCrawl("https://example.com", null);
        client.startBatchScrape(List.of("https://example.com"), BatchScrapeOptions.builder()
                .options(ScrapeOptions.builder().formats(List.<Object>of("markdown")).build())
                .build());
        client.map("https://example.com");

        for (String path : List.of("/v2/crawl", "/v2/batch/scrape", "/v2/map")) {
            String origin = body(path).path("origin").asText();
            assertTrue(origin.matches("java-sdk@\\d+\\.\\d+\\.\\d+"), path + " origin was '" + origin + "'");
        }
        assertEquals("markdown", body("/v2/batch/scrape").path("formats").path(0).asText());
    }
}
