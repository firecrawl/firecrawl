package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.client.FirecrawlClient;
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
 * POST /v2/browser location tests against a local mock HTTP server.
 */
class BrowserLocationMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastPath.set(exchange.getRequestURI().getPath());
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] bytes = "{\"success\":true,\"id\":\"session-1\"}".getBytes(StandardCharsets.UTF_8);
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
    void testBrowserSendsLocation() throws IOException {
        client.browser(null, null, null, "GB");

        assertEquals("/v2/browser", lastPath.get());
        JsonNode body = new ObjectMapper().readTree(lastBody.get());
        assertEquals("GB", body.path("location").path("country").asText());
    }

    @Test
    void testBrowserOmitsLocationWhenUnset() throws IOException {
        client.browser(60, null, null);

        JsonNode body = new ObjectMapper().readTree(lastBody.get());
        assertEquals(60, body.path("ttl").asInt());
        assertFalse(body.has("location"));
    }
}
