package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Verifies that auto-pagination only ever sends requests (and the API key) to the
 * configured API origin, whatever host the server-supplied "next" URL points at.
 */
class PaginationOriginTest {

    private static final String API_KEY = "fc-test-key";

    private HttpServer api;
    private HttpServer foreign;
    private final List<String> apiRequests = new CopyOnWriteArrayList<>();
    private final List<String> foreignRequests = new CopyOnWriteArrayList<>();
    private volatile String nextUrl;

    @BeforeEach
    void setup() throws IOException {
        foreign = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        foreign.createContext("/", exchange -> {
            foreignRequests.add(exchange.getRequestURI().toString());
            respond(exchange, "{\"success\":true,\"status\":\"completed\",\"data\":[]}");
        });
        foreign.start();

        api = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        api.createContext("/", this::handleApi);
        api.start();
    }

    @AfterEach
    void teardown() {
        api.stop(0);
        foreign.stop(0);
    }

    private void handleApi(HttpExchange exchange) throws IOException {
        String uri = exchange.getRequestURI().toString();
        apiRequests.add(exchange.getRequestMethod() + " " + uri + " "
                + exchange.getRequestHeaders().getFirst("Authorization"));
        switch (uri) {
            case "/v2/crawl":
            case "/v2/batch/scrape":
                respond(exchange, "{\"success\":true,\"id\":\"abc\"}");
                return;
            case "/v2/crawl/abc":
            case "/v2/batch/scrape/abc":
                respond(exchange, "{\"status\":\"completed\",\"data\":[{\"markdown\":\"page-1\"}],"
                        + "\"next\":\"" + nextUrl + "\"}");
                return;
            case "/v2/crawl/abc?skip=10":
            case "/v2/batch/scrape/abc?skip=10":
                respond(exchange, "{\"status\":\"completed\",\"data\":[{\"markdown\":\"page-2\"}]}");
                return;
            case "/v2/monitor/m1/checks/c1":
                respond(exchange, "{\"success\":true,\"data\":{\"id\":\"c1\","
                        + "\"pages\":[{\"url\":\"https://a.example\"}],\"next\":\"" + nextUrl + "\"}}");
                return;
            case "/v2/monitor/m1/checks/c1?skip=10":
                respond(exchange, "{\"success\":true,\"data\":{\"id\":\"c1\","
                        + "\"pages\":[{\"url\":\"https://b.example\"}]}}");
                return;
            default:
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
        }
    }

    private static void respond(HttpExchange exchange, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    static Stream<Arguments> cases() {
        String[] followers = {"crawl", "batch/scrape", "monitor"};
        String[] origins = {
                "same-origin|http://127.0.0.1:{api}",
                "cross-host|https://evil.example",
                "cross-host-reachable|http://localhost:{foreign}",
                "protocol-relative|//evil.example",
                "different-port|http://127.0.0.1:{foreign}",
                "different-scheme|https://127.0.0.1:{api}",
                "relative|",
        };
        return Stream.of(followers).flatMap(follower -> Stream.of(origins).map(origin -> {
            String[] parts = origin.split("\\|", -1);
            return Arguments.of(follower, parts[0], parts[1]);
        }));
    }

    @ParameterizedTest(name = "{0} follows {1} next URL on the API origin")
    @MethodSource("cases")
    void nextUrlIsPinnedToApiOrigin(String follower, String label, String originTemplate) {
        String path = follower.equals("monitor") ? "/v2/monitor/m1/checks/c1" : "/v2/" + follower + "/abc";
        nextUrl = originTemplate
                .replace("{api}", String.valueOf(api.getAddress().getPort()))
                .replace("{foreign}", String.valueOf(foreign.getAddress().getPort()))
                + path + "?skip=10";

        FirecrawlClient client = FirecrawlClient.builder()
                .apiKey(API_KEY)
                .apiUrl("http://127.0.0.1:" + api.getAddress().getPort())
                .maxRetries(0)
                .timeoutMs(5_000)
                .build();

        int results;
        switch (follower) {
            case "crawl":
                results = client.crawl("https://example.com", null, 1, 30).getData().size();
                break;
            case "batch/scrape":
                results = client.batchScrape(Collections.singletonList("https://example.com"), null, 1, 30)
                        .getData().size();
                break;
            default:
                results = client.getMonitorCheck("m1", "c1").getPages().size();
        }

        assertEquals(2, results);
        assertTrue(apiRequests.contains("GET " + path + "?skip=10 Bearer " + API_KEY),
                "next page was not requested on the API origin with the API key: " + apiRequests);
        assertTrue(foreignRequests.isEmpty(), "request leaked to foreign origin: " + foreignRequests);
    }
}
