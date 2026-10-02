package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.errors.AuthenticationException;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.models.ParseFormat;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * GET /v2/parse/formats tests against a local mock HTTP server.
 */
class ParseFormatsMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> lastMethod = new AtomicReference<>();
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastAuth = new AtomicReference<>();
    private final AtomicInteger responseStatus = new AtomicInteger(200);
    private final AtomicReference<String> responseBody = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastMethod.set(exchange.getRequestMethod());
            lastPath.set(exchange.getRequestURI().toString());
            lastAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            byte[] bytes = responseBody.get().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(responseStatus.get(), bytes.length);
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

    private void respondWith(int status, String body) {
        responseStatus.set(status);
        responseBody.set(body);
    }

    @Test
    void testGetParseFormats() {
        respondWith(200, "{\"success\":true,\"data\":{\"formats\":["
                + "{\"format\":\"pdf\",\"kind\":\"document\",\"extensions\":[\".pdf\"],"
                + "\"mimeTypes\":[\"application/pdf\"],\"available\":true},"
                + "{\"format\":\"png\",\"kind\":\"image\",\"extensions\":[\".png\"],"
                + "\"mimeTypes\":[\"image/png\"],\"available\":false}"
                + "]}}");

        List<ParseFormat> formats = client.getParseFormats();

        assertEquals("GET", lastMethod.get());
        assertEquals("/v2/parse/formats", lastPath.get());
        assertEquals("Bearer fc-test-key", lastAuth.get());

        assertEquals(2, formats.size());
        ParseFormat pdf = formats.get(0);
        assertEquals("pdf", pdf.getFormat());
        assertEquals("document", pdf.getKind());
        assertEquals(ParseFormat.Kind.DOCUMENT, pdf.getKindType());
        assertEquals(List.of(".pdf"), pdf.getExtensions());
        assertEquals(List.of("application/pdf"), pdf.getMimeTypes());
        assertTrue(pdf.isAvailable());

        ParseFormat png = formats.get(1);
        assertEquals("png", png.getFormat());
        assertEquals(ParseFormat.Kind.IMAGE, png.getKindType());
        assertEquals(List.of("image/png"), png.getMimeTypes());
        assertFalse(png.isAvailable());
    }

    @Test
    void testGetParseFormatsToleratesUnknownKindAndFields() {
        respondWith(200, "{\"success\":true,\"data\":{\"formats\":["
                + "{\"format\":\"mp3\",\"kind\":\"audio\",\"extensions\":[\".mp3\"],"
                + "\"mimeTypes\":[\"audio/mpeg\"],\"available\":true,\"maxSizeMb\":50}"
                + "]},\"extra\":true}");

        List<ParseFormat> formats = client.getParseFormats();

        assertEquals(1, formats.size());
        ParseFormat mp3 = formats.get(0);
        assertEquals("mp3", mp3.getFormat());
        assertEquals("audio", mp3.getKind());
        assertEquals(ParseFormat.Kind.UNKNOWN, mp3.getKindType());
        assertEquals(List.of("audio/mpeg"), mp3.getMimeTypes());
        assertTrue(mp3.isAvailable());
    }

    @Test
    void testGetParseFormatsReturnsEmptyListWhenFormatsMissing() {
        respondWith(200, "{\"success\":true,\"data\":{}}");
        assertTrue(client.getParseFormats().isEmpty());

        respondWith(200, "{\"success\":true}");
        assertTrue(client.getParseFormats().isEmpty());
    }

    @Test
    void testParseFormatSerializesOnlyWireFields() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        ParseFormat pdf = mapper.readValue("{\"format\":\"pdf\",\"kind\":\"document\","
                + "\"extensions\":[\".pdf\"],\"mimeTypes\":[\"application/pdf\"],\"available\":true}", ParseFormat.class);

        JsonNode json = mapper.valueToTree(pdf);
        assertEquals("document", json.get("kind").asText());
        assertFalse(json.has("kindType"));
    }

    @Test
    void testGetParseFormatsUnauthorized() {
        respondWith(401, "{\"success\":false,\"error\":\"Unauthorized: Invalid token\"}");

        AuthenticationException e = assertThrows(AuthenticationException.class, () -> client.getParseFormats());
        assertEquals(401, e.getStatusCode());
        assertEquals("Unauthorized: Invalid token", e.getMessage());
    }

    @Test
    void testGetParseFormatsServerError() {
        respondWith(500, "{\"success\":false,\"error\":\"Internal server error\"}");

        FirecrawlException e = assertThrows(FirecrawlException.class, () -> client.getParseFormats());
        assertEquals(500, e.getStatusCode());
    }

    @Test
    void testGetParseFormatsAsync() throws Exception {
        respondWith(200, "{\"success\":true,\"data\":{\"formats\":["
                + "{\"format\":\"pdf\",\"kind\":\"document\",\"extensions\":[\".pdf\"],"
                + "\"mimeTypes\":[\"application/pdf\"],\"available\":true}"
                + "]}}");

        List<ParseFormat> formats = client.getParseFormatsAsync().get();

        assertEquals(1, formats.size());
        assertEquals("pdf", formats.get(0).getFormat());
    }
}
