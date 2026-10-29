package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.ResearchModels;
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
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class DeveloperSearchMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> requestLine = new AtomicReference<>();
    private final AtomicReference<String> requestBody = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requestLine.set(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] bytes = ("{\"success\":true,\"results\":[{\"id\":\"r1\","
                    + "\"url\":\"https://github.com/square/okhttp/issues/1\",\"title\":\"retry\","
                    + "\"passages\":[{\"text\":\"use backoff\",\"citation_url\":\"https://github.com/square/okhttp/issues/1#c1\"}],"
                    + "\"license\":{\"state\":\"licensed\",\"spdx_id\":\"Apache-2.0\"}},"
                    + "{\"id\":\"r2\",\"url\":\"https://github.com/square/okhttp\",\"passages\":[],\"license\":\"Apache-2.0\"}],"
                    + "\"repos\":[{\"repo\":\"square/okhttp\",\"indexed\":true,"
                    + "\"types\":{\"issue\":true,\"pullRequest\":true,\"readme\":false}}]}")
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
    void developerSearchPostsQueryAndOptions() {
        ResearchModels.DeveloperSearchOptions options = new ResearchModels.DeveloperSearchOptions();
        options.k = 5;
        options.types = List.of("issue");
        options.repos = List.of("square/okhttp");
        options.minStars = 100L;

        ResearchModels.DeveloperSearchResponse response = client.developerSearch("retry backoff", options);

        assertEquals("POST /v2/search/developer", requestLine.get());
        String body = requestBody.get();
        for (String want : List.of("\"query\":\"retry backoff\"", "\"k\":5", "\"types\":[\"issue\"]",
                "\"repos\":[\"square/okhttp\"]", "\"min_stars\":100", "\"origin\":\"java-sdk@")) {
            assertTrue(body.contains(want), "request body missing " + want + ": " + body);
        }
        assertFalse(body.contains("null"), "unset options must be omitted: " + body);

        assertTrue(response.success);
        assertEquals(2, response.results.size());
        assertEquals("https://github.com/square/okhttp/issues/1#c1", response.results.get(0).passages.get(0).citationUrl);
        assertEquals("Apache-2.0", ((Map<?, ?>) response.results.get(0).license).get("spdx_id"));
        assertEquals("Apache-2.0", response.results.get(1).license);
        assertTrue(response.repos.get(0).indexed);
        assertTrue(response.repos.get(0).types.pullRequest);
        assertNull(response.sources);
    }

    @Test
    void developerSearchAsyncPostsQuery() {
        ResearchModels.DeveloperSearchResponse response = client.developerSearchAsync("okhttp interceptor", null).join();

        assertEquals("POST /v2/search/developer", requestLine.get());
        assertTrue(requestBody.get().contains("\"query\":\"okhttp interceptor\""), requestBody.get());
        assertTrue(response.success);
        assertEquals(2, response.results.size());
    }

    @Test
    void developerSearchAsyncFailsOnBlankQuery() {
        CompletionException error = assertThrows(CompletionException.class,
                () -> client.developerSearchAsync(" ", null).join());
        assertInstanceOf(IllegalArgumentException.class, error.getCause());
        assertNull(requestLine.get());
    }

    @Test
    void developerSearchRejectsBlankQuery() {
        assertThrows(IllegalArgumentException.class, () -> client.developerSearch("   "));
        assertThrows(NullPointerException.class, () -> client.developerSearch(null));
        assertNull(requestLine.get());
    }
}
