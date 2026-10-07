package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.AgentExchangeOptions;
import com.firecrawl.models.AgentExchangeSummary;
import com.firecrawl.models.AgentListItem;
import com.firecrawl.models.AgentListResponse;
import com.firecrawl.models.AgentOptions;
import com.firecrawl.models.AgentPendingApproval;
import com.firecrawl.models.AgentPendingApprovalCall;
import com.firecrawl.models.AgentResponse;
import com.firecrawl.models.AgentSnapshotResponse;
import com.firecrawl.models.AgentStatusResponse;
import com.firecrawl.models.AgentTermsActionProvider;
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
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Agent endpoint tests against a local mock HTTP server.
 *
 * Verifies request serialization (effort, thread and exchange options, query
 * params) and response parsing for the agent status, trace and snapshot
 * endpoints without requiring a live API key.
 */
class AgentMockTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String THREAD_ID = "0199bbbb-0000-7000-8000-000000000000";
    private static final String APPROVAL_ID = "0199aaaa-0000-7000-8000-000000000000";

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
            if ("GET".equals(exchange.getRequestMethod())) {
                respond(exchange, 200, "{"
                        + "\"success\":true,"
                        + "\"agents\":[{"
                        + "  \"id\":\"job-123\","
                        + "  \"createdAt\":\"2026-08-31T12:00:00.000Z\","
                        + "  \"targetHint\":\"https://example.com\","
                        + "  \"origin\":\"api\","
                        + "  \"settings\":{\"hidden\":false,\"starred\":true,\"label\":\"prod\"},"
                        + "  \"status\":\"completed\","
                        + "  \"options\":{\"urls\":[\"https://example.com\"],\"prompt\":\"find pricing\",\"model\":\"spark-1-pro\"}"
                        + "}]"
                        + "}");
            } else {
                respond(exchange, 200, "{\"success\":true,\"id\":\"job-123\","
                        + "\"threadId\":\"" + THREAD_ID + "\",\"threadTurn\":2}");
            }
        });

        server.createContext("/v2/agent/job-123", exchange -> {
            lastRequestPath.set(exchange.getRequestURI().toString());
            respond(exchange, 200, "{"
                    + "\"success\":true,\"status\":\"completed\",\"model\":\"spark-2\","
                    + "\"expiresAt\":\"2026-10-07T00:00:00.000Z\",\"creditsUsed\":12,"
                    + "\"threadId\":\"" + THREAD_ID + "\",\"threadTurn\":2,\"mode\":\"chat\","
                    + "\"message\":\"One paid call needs your approval.\","
                    + "\"suggestions\":[{\"label\":\"Approve\",\"prompt\":\"Go ahead\"}],"
                    + "\"someFutureField\":{\"nested\":true},"
                    + "\"pendingApproval\":{\"id\":\"" + APPROVAL_ID + "\",\"kind\":\"calls\","
                    + "  \"reason\":\"Provider A charges per lookup.\","
                    + "  \"calls\":[{\"id\":\"call-1\",\"provider\":\"provider-a\",\"capability\":\"people/search\","
                    + "    \"input\":{\"query\":\"example\",\"limit\":5},\"more\":[{\"query\":\"example 2\"}],"
                    + "    \"creditsEstimate\":4,\"futureCallField\":1}],"
                    + "  \"resolution\":null},"
                    + "\"exchange\":{\"enabled\":true,\"toolkits\":[\"provider-a\"],\"requireApproval\":true,"
                    + "  \"onTermsRequired\":\"ask\",\"paidCalls\":1,\"creditsUsed\":null,"
                    + "  \"skippedProviders\":[{\"provider\":\"provider-b\",\"name\":\"Provider B\","
                    + "    \"capability\":\"company/enrich\",\"adds\":\"verified work emails\","
                    + "    \"reason\":\"terms_required\",\"version\":\"F-1.0.0\","
                    + "    \"termsUrl\":\"https://www.firecrawl.dev/app/alexandria/provider-b\"}],"
                    + "  \"requiresAction\":{\"type\":\"accept_terms\",\"approvalId\":\"" + APPROVAL_ID + "\","
                    + "    \"providers\":[{\"provider\":\"provider-b\",\"name\":\"Provider B\",\"version\":\"F-1.0.0\","
                    + "      \"digest\":null,\"url\":\"https://www.firecrawl.dev/app/alexandria/provider-b\","
                    + "      \"show\":{\"provider\":\"firecrawl\",\"capability\":\"terms/show\","
                    + "        \"options\":{\"provider\":\"provider-b\"}},"
                    + "      \"accept\":{\"provider\":\"firecrawl\",\"capability\":\"terms/accept\","
                    + "        \"options\":{\"provider\":\"provider-b\",\"version\":\"F-1.0.0\",\"digest\":null,\"confirmed\":true}}}]}}"
                    + "}");
        });

        server.createContext("/v2/agent/job-terms", exchange -> {
            lastRequestPath.set(exchange.getRequestURI().toString());
            respond(exchange, 200, "{"
                    + "\"success\":true,\"status\":\"completed\",\"expiresAt\":\"2026-10-07T00:00:00.000Z\","
                    + "\"pendingApproval\":{\"id\":\"" + APPROVAL_ID + "\",\"kind\":\"terms\","
                    + "  \"reason\":\"Provider B could add verified work emails.\",\"calls\":[],"
                    + "  \"terms\":[{\"provider\":\"provider-b\",\"name\":\"Provider B\",\"logo\":\"https://example.com/b.png\","
                    + "    \"version\":\"F-1.0.0\",\"digest\":\"sha256:abc\",\"url\":\"https://www.firecrawl.dev/app/alexandria/provider-b\"}],"
                    + "  \"resolution\":{\"approved\":true,\"callIds\":[],\"always\":false,\"byRunId\":\"job-next\"}}"
                    + "}");
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
    void testStartAgentSendsExchangeThreadAndMode() throws IOException {
        AgentResponse response = client.startAgent(
                AgentOptions.builder()
                        .prompt("Continue")
                        .threadId(THREAD_ID)
                        .mode("chat")
                        .exchange(AgentExchangeOptions.builder()
                                .enabled(true)
                                .toolkits(List.of("provider-a", "provider-b"))
                                .maxCalls(8)
                                .requireApproval(true)
                                .approve(new AgentExchangeOptions.Approve(APPROVAL_ID, List.of("call-1", "call-2"), true))
                                .decline(new AgentExchangeOptions.Decline(APPROVAL_ID))
                                .onTermsRequired("ask")
                                .build())
                        .build());

        assertEquals(THREAD_ID, response.getThreadId());
        assertEquals(2, response.getThreadTurn());

        JsonNode body = MAPPER.readTree(lastRequestBody.get());
        assertEquals(THREAD_ID, body.get("threadId").asText());
        assertEquals("chat", body.get("mode").asText());
        assertEquals(MAPPER.readTree("{"
                + "\"enabled\":true,"
                + "\"toolkits\":[\"provider-a\",\"provider-b\"],"
                + "\"maxCalls\":8,"
                + "\"requireApproval\":true,"
                + "\"approve\":{\"approvalId\":\"" + APPROVAL_ID + "\",\"callIds\":[\"call-1\",\"call-2\"],\"always\":true},"
                + "\"decline\":{\"approvalId\":\"" + APPROVAL_ID + "\"},"
                + "\"onTermsRequired\":\"ask\""
                + "}"), body.get("exchange"));
    }

    @Test
    void testStartAgentOmitsThreadModeAndExchangeWhenNotSet() throws IOException {
        AgentResponse response = client.startAgent(AgentOptions.builder().prompt("Hello").build());

        JsonNode body = MAPPER.readTree(lastRequestBody.get());
        assertFalse(body.has("threadId"), "Request body should not contain threadId: " + body);
        assertFalse(body.has("mode"), "Request body should not contain mode: " + body);
        assertFalse(body.has("exchange"), "Request body should not contain exchange: " + body);
        assertEquals("job-123", response.getId());
    }

    @Test
    void testStartAgentOmitsUnsetExchangeFields() throws IOException {
        client.startAgent(AgentOptions.builder()
                .prompt("Continue")
                .threadId(THREAD_ID)
                .exchange(AgentExchangeOptions.builder()
                        .enabled(true)
                        .approve(new AgentExchangeOptions.Approve(APPROVAL_ID))
                        .build())
                .build());

        JsonNode body = MAPPER.readTree(lastRequestBody.get());
        assertEquals(MAPPER.readTree("{\"enabled\":true,\"approve\":{\"approvalId\":\"" + APPROVAL_ID + "\"}}"),
                body.get("exchange"));
    }

    @Test
    void testApproveAndDeclineRequireApprovalId() {
        assertThrows(NullPointerException.class, () -> new AgentExchangeOptions.Approve(null));
        assertThrows(NullPointerException.class, () -> new AgentExchangeOptions.Approve(null, List.of("call-1"), true));
        assertThrows(NullPointerException.class, () -> new AgentExchangeOptions.Decline(null));
    }

    @Test
    void testAgentParsesExchangeSummaryAndPendingApproval() throws IOException {
        AgentStatusResponse status = client.agent(
                AgentOptions.builder()
                        .prompt("Find the contact at example.com")
                        .mode("chat")
                        .exchange(AgentExchangeOptions.builder().requireApproval(true).build())
                        .build(),
                1, 10);

        assertEquals("{\"requireApproval\":true}",
                MAPPER.readTree(lastRequestBody.get()).get("exchange").toString());
        assertEquals("/v2/agent/job-123", lastRequestPath.get());

        assertTrue(status.isDone());
        assertEquals(THREAD_ID, status.getThreadId());
        assertEquals(2, status.getThreadTurn());
        assertEquals("chat", status.getMode());
        assertEquals("One paid call needs your approval.", status.getMessage());

        AgentPendingApproval pending = status.getPendingApproval();
        assertNotNull(pending);
        assertEquals(APPROVAL_ID, pending.getId());
        assertEquals("calls", pending.getKind());
        assertEquals("Provider A charges per lookup.", pending.getReason());
        assertNull(pending.getTerms());
        assertNull(pending.getResolution());
        AgentPendingApprovalCall call = pending.getCalls().get(0);
        assertEquals("call-1", call.getId());
        assertEquals("provider-a", call.getProvider());
        assertEquals("people/search", call.getCapability());
        assertEquals("example", call.getInput().get("query"));
        assertEquals(5, call.getInput().get("limit"));
        assertEquals("example 2", call.getMore().get(0).get("query"));
        assertEquals(4, call.getCreditsEstimate());

        AgentExchangeSummary exchange = status.getExchange();
        assertNotNull(exchange);
        assertTrue(exchange.isEnabled());
        assertEquals(List.of("provider-a"), exchange.getToolkits());
        assertTrue(exchange.getRequireApproval());
        assertEquals("ask", exchange.getOnTermsRequired());
        assertEquals(1, exchange.getPaidCalls());
        assertNull(exchange.getCreditsUsed());

        assertEquals(1, exchange.getSkippedProviders().size());
        assertEquals("provider-b", exchange.getSkippedProviders().get(0).getProvider());
        assertEquals("Provider B", exchange.getSkippedProviders().get(0).getName());
        assertEquals("company/enrich", exchange.getSkippedProviders().get(0).getCapability());
        assertEquals("verified work emails", exchange.getSkippedProviders().get(0).getAdds());
        assertEquals("terms_required", exchange.getSkippedProviders().get(0).getReason());
        assertEquals("F-1.0.0", exchange.getSkippedProviders().get(0).getVersion());
        assertEquals("https://www.firecrawl.dev/app/alexandria/provider-b",
                exchange.getSkippedProviders().get(0).getTermsUrl());

        assertEquals("accept_terms", exchange.getRequiresAction().getType());
        assertEquals(APPROVAL_ID, exchange.getRequiresAction().getApprovalId());
        AgentTermsActionProvider provider = exchange.getRequiresAction().getProviders().get(0);
        assertEquals("provider-b", provider.getProvider());
        assertEquals("F-1.0.0", provider.getVersion());
        assertNull(provider.getDigest());
        assertEquals("https://www.firecrawl.dev/app/alexandria/provider-b", provider.getUrl());
        assertEquals("terms/show", provider.getShow().get("capability"));
        assertEquals("terms/accept", provider.getAccept().get("capability"));
        Map<?, ?> acceptOptions = (Map<?, ?>) provider.getAccept().get("options");
        assertTrue(acceptOptions.containsKey("digest"));
        assertNull(acceptOptions.get("digest"));
        assertEquals(true, acceptOptions.get("confirmed"));
    }

    @Test
    void testGetAgentStatusParsesTermsApproval() {
        AgentStatusResponse status = client.getAgentStatus("job-terms");

        AgentPendingApproval pending = status.getPendingApproval();
        assertEquals("terms", pending.getKind());
        assertTrue(pending.getCalls().isEmpty());
        assertEquals("provider-b", pending.getTerms().get(0).getProvider());
        assertEquals("https://example.com/b.png", pending.getTerms().get(0).getLogo());
        assertEquals("sha256:abc", pending.getTerms().get(0).getDigest());
        assertTrue(pending.getResolution().isApproved());
        assertFalse(pending.getResolution().isAlways());
        assertEquals("job-next", pending.getResolution().getByRunId());
        assertNull(status.getExchange());
        assertNull(status.getThreadId());
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

    @Test
    void testListAgents() {
        AgentListResponse response = client.listAgents();

        assertEquals("/v2/agent", lastRequestPath.get(),
                "Should not send a query string by default");
        assertTrue(response.isSuccess());
        assertNull(response.getNext());
        assertNotNull(response.getAgents());
        assertEquals(1, response.getAgents().size());

        AgentListItem agent = response.getAgents().get(0);
        assertEquals("job-123", agent.getId());
        assertEquals("2026-08-31T12:00:00.000Z", agent.getCreatedAt());
        assertEquals("https://example.com", agent.getTargetHint());
        assertEquals("api", agent.getOrigin());
        assertEquals("completed", agent.getStatus());
        assertNotNull(agent.getSettings());
        assertFalse(agent.getSettings().isHidden());
        assertTrue(agent.getSettings().isStarred());
        assertEquals("prod", agent.getSettings().getLabel());
        assertNotNull(agent.getOptions());
        assertEquals("find pricing", agent.getOptions().getPrompt());
        assertEquals("spark-1-pro", agent.getOptions().getModel());
    }

    @Test
    void testListAgentsSendsBefore() {
        AgentListResponse response = client.listAgents(1756600000000L);

        assertEquals("/v2/agent?before=1756600000000", lastRequestPath.get(),
                "Should append before query param");
        assertTrue(response.isSuccess());
    }
}
