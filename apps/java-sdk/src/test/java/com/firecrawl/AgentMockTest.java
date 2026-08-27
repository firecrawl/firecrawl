package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.AgentOptions;
import com.firecrawl.models.AgentResponse;
import com.firecrawl.models.AgentSnapshotResponse;
import com.firecrawl.models.AgentTraceEvent;
import com.firecrawl.models.AgentTraceResponse;
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
 * Agent endpoint tests against a local mock HTTP server.
 *
 * Verifies request serialization (effort parameter, query params) and
 * response parsing for the agent trace and snapshot endpoints without
 * requiring a live API key.
 */
class AgentMockTest {

    private HttpServer server;
    private FirecrawlClient client;
    private final AtomicReference<String> lastRequestBody = new AtomicReference<>();
    private final AtomicReference<String> lastRequestPath = new AtomicReference<>();

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);

        server.createContext("/v2/agent", exchange -> {
            lastRequestPath.set(exchange.getRequestURI().toString());
            lastRequestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, "{\"success\":true,\"id\":\"job-123\"}");
        });

        server.createContext("/v2/agent/job-123/trace", exchange -> {
            lastRequestPath.set(exchange.getRequestURI().toString());
            respond(exchange, 200, "{"
                    + "\"success\":true,"
                    + "\"id\":\"job-123\","
                    + "\"creditsUsed\":5,"
                    + "\"events\":["
                    + "  {\"type\":\"run.started\",\"schemaVersion\":1,\"eventId\":\"evt-1\",\"runId\":\"job-123\","
                    + "   \"occurredAt\":\"2026-01-01T00:00:00Z\",\"producerSequence\":1,"
                    + "   \"agent\":{\"id\":\"agent-1\",\"role\":\"primary\",\"name\":\"Spark\",\"parentId\":null}},"
                    + "  {\"type\":\"tool_call.started\",\"schemaVersion\":1,\"eventId\":\"evt-2\",\"runId\":\"job-123\","
                    + "   \"occurredAt\":\"2026-01-01T00:00:01Z\",\"producerSequence\":2,"
                    + "   \"agent\":{\"id\":\"agent-1\",\"role\":\"primary\",\"name\":\"Spark\"},"
                    + "   \"toolCallId\":\"tc-1\",\"toolName\":\"scrape\",\"parameters\":{\"url\":\"https://example.com\"}},"
                    + "  {\"type\":\"artifact.updated\",\"schemaVersion\":1,\"eventId\":\"evt-3\",\"runId\":\"job-123\","
                    + "   \"occurredAt\":\"2026-01-01T00:00:02Z\",\"producerSequence\":3,"
                    + "   \"agent\":{\"id\":\"agent-1\",\"role\":\"primary\",\"name\":\"Spark\"},"
                    + "   \"artifact\":{\"kind\":\"data\",\"artifactId\":\"art-1\",\"path\":\"result\",\"snapshotId\":\"snap-1\","
                    + "   \"change\":\"created\",\"changedFields\":[\"title\"],\"itemCount\":1,\"sourceToolCallId\":\"tc-1\"}}"
                    + "],"
                    + "\"activeBrowserSessions\":[{\"id\":\"sess-1\",\"liveViewUrl\":\"https://live.example.com/sess-1\","
                    + "\"viewport\":{\"width\":1280,\"height\":720}}]"
                    + "}");
        });

        server.createContext("/v2/agent/job-123/snapshots/snap-1", exchange -> {
            lastRequestPath.set(exchange.getRequestURI().toString());
            respond(exchange, 200, "{\"success\":true,\"id\":\"job-123\",\"snapshotId\":\"snap-1\","
                    + "\"snapshot\":\"snapshot content here\"}");
        });

        server.start();
        client = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .apiUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .build();
    }

    @AfterEach
    void teardown() {
        server.stop(0);
    }

    private static void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    @Test
    void testStartAgentSendsEffort() {
        AgentResponse response = client.startAgent(
                AgentOptions.builder()
                        .prompt("Research Firecrawl features")
                        .model("spark-2")
                        .effort("high")
                        .build());

        assertTrue(response.isSuccess());
        assertEquals("job-123", response.getId());

        String body = lastRequestBody.get();
        assertNotNull(body, "Request body should have been captured");
        assertTrue(body.contains("\"effort\":\"high\""),
                "Request body should contain effort: " + body);
        assertTrue(body.contains("\"model\":\"spark-2\""),
                "Request body should contain model: " + body);
        assertTrue(body.contains("\"prompt\":\"Research Firecrawl features\""),
                "Request body should contain prompt: " + body);
    }

    @Test
    void testStartAgentOmitsEffortWhenNotSet() {
        client.startAgent(AgentOptions.builder().prompt("Hello").build());

        String body = lastRequestBody.get();
        assertNotNull(body);
        assertFalse(body.contains("effort"), "Request body should not contain effort: " + body);
    }

    @Test
    void testGetAgentTraceParsesEvents() {
        AgentTraceResponse trace = client.getAgentTrace("job-123");

        assertEquals("/v2/agent/job-123/trace", lastRequestPath.get(),
                "Should not send liveView param by default");

        assertTrue(trace.isSuccess());
        assertEquals("job-123", trace.getId());
        assertEquals(5, trace.getCreditsUsed());
        assertNotNull(trace.getEvents());
        assertEquals(3, trace.getEvents().size());

        AgentTraceEvent started = trace.getEvents().get(0);
        assertEquals("run.started", started.getType());
        assertEquals(1, started.getSchemaVersion());
        assertEquals("evt-1", started.getEventId());
        assertEquals("job-123", started.getRunId());
        assertEquals("2026-01-01T00:00:00Z", started.getOccurredAt());
        assertEquals(1L, started.getProducerSequence());
        assertNotNull(started.getAgent());
        assertEquals("agent-1", started.getAgent().getId());
        assertEquals("primary", started.getAgent().getRole());
        assertEquals("Spark", started.getAgent().getName());

        AgentTraceEvent toolCall = trace.getEvents().get(1);
        assertEquals("tool_call.started", toolCall.getType());
        assertEquals("tc-1", toolCall.getToolCallId());
        assertEquals("scrape", toolCall.getToolName());
        assertNotNull(toolCall.getParameters());

        AgentTraceEvent artifact = trace.getEvents().get(2);
        assertEquals("artifact.updated", artifact.getType());
        assertNotNull(artifact.getArtifact());
        assertEquals("art-1", artifact.getArtifact().getArtifactId());
        assertEquals("snap-1", artifact.getArtifact().getSnapshotId());
        assertEquals("created", artifact.getArtifact().getChange());
        assertEquals(java.util.List.of("title"), artifact.getArtifact().getChangedFields());
        assertEquals(1, artifact.getArtifact().getItemCount());
        assertEquals("tc-1", artifact.getArtifact().getSourceToolCallId());

        // liveView not requested: activeBrowserSessions may still parse if present
        assertNotNull(trace.getActiveBrowserSessions());
        assertEquals("sess-1", trace.getActiveBrowserSessions().get(0).getId());
        assertEquals(1280, trace.getActiveBrowserSessions().get(0).getViewport().getWidth());
        assertEquals(720, trace.getActiveBrowserSessions().get(0).getViewport().getHeight());
    }

    @Test
    void testGetAgentTraceWithLiveView() {
        AgentTraceResponse trace = client.getAgentTrace("job-123", true);

        assertEquals("/v2/agent/job-123/trace?liveView=true", lastRequestPath.get(),
                "Should append liveView=true query param");
        assertTrue(trace.isSuccess());
        assertNotNull(trace.getActiveBrowserSessions());
        assertEquals(1, trace.getActiveBrowserSessions().size());
        assertEquals("https://live.example.com/sess-1",
                trace.getActiveBrowserSessions().get(0).getLiveViewUrl());
    }

    @Test
    void testGetAgentSnapshot() {
        AgentSnapshotResponse snapshot = client.getAgentSnapshot("job-123", "snap-1");

        assertEquals("/v2/agent/job-123/snapshots/snap-1", lastRequestPath.get());
        assertTrue(snapshot.isSuccess());
        assertEquals("job-123", snapshot.getId());
        assertEquals("snap-1", snapshot.getSnapshotId());
        assertEquals("snapshot content here", snapshot.getSnapshot());
        assertNull(snapshot.getError());
    }
}
