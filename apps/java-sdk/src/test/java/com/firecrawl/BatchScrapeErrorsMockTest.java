package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
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
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class BatchScrapeErrorsMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> requestLine = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requestLine.set(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            byte[] bytes = ("{\"errors\":[{\"id\":\"e1\",\"timestamp\":\"2026-01-01T00:00:00Z\","
                    + "\"url\":\"https://example.com/a\",\"error\":\"timeout\"}],"
                    + "\"robotsBlocked\":[\"https://example.com/private\"]}")
                    .getBytes(StandardCharsets.UTF_8);
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
    @SuppressWarnings("unchecked")
    void getBatchScrapeErrorsReturnsErrorsAndRobotsBlocks() {
        Map<String, Object> result = client.getBatchScrapeErrors("job-1");

        assertEquals("GET /v2/batch/scrape/job-1/errors", requestLine.get());
        List<Map<String, Object>> errors = (List<Map<String, Object>>) result.get("errors");
        assertEquals(1, errors.size());
        assertEquals("https://example.com/a", errors.get(0).get("url"));
        assertEquals(List.of("https://example.com/private"), result.get("robotsBlocked"));
    }

    @Test
    void getBatchScrapeErrorsRequiresJobId() {
        assertThrows(NullPointerException.class, () -> client.getBatchScrapeErrors(null));
        assertNull(requestLine.get());
    }
}
