package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.BrowserCreateResponse;
import com.firecrawl.models.BrowserDeleteResponse;
import com.firecrawl.models.BrowserExecuteResponse;
import com.firecrawl.models.BrowserListResponse;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Browser Sandbox Endpoint Tests
 *
 * Tests the browser session management functionality of the Firecrawl Java SDK.
 * These tests require FIRECRAWL_API_KEY environment variable to be set.
 *
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.BrowserTest"
 */
class BrowserTest {

    private static FirecrawlClient client;

    @BeforeAll
    static void setup() {
        String apiKey = System.getenv("FIRECRAWL_API_KEY");
        if (apiKey != null && !apiKey.isBlank()) {
            client = FirecrawlClient.fromEnv();
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserCreateAndDelete() {
        System.out.println("Testing browser session create and delete...");

        // Create a browser session
        BrowserCreateResponse createRes = client.browser();
        assertNotNull(createRes, "Create response should not be null");
        assertTrue(createRes.isSuccess(), "Create should succeed");
        assertNotNull(createRes.getId(), "Session ID should not be null");

        String sessionId = createRes.getId();
        System.out.println("  Created session: " + sessionId);

        // Delete the browser session
        BrowserDeleteResponse deleteRes = client.deleteBrowser(sessionId);
        assertNotNull(deleteRes, "Delete response should not be null");
        assertTrue(deleteRes.isSuccess(), "Delete should succeed");

        System.out.println("✓ Browser create and delete test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserCreateWithOptions() {
        System.out.println("Testing browser session create with options...");

        // Create a session with custom TTL and activity TTL
        BrowserCreateResponse createRes = client.browser(300, 120, true);
        assertNotNull(createRes, "Create response should not be null");
        assertTrue(createRes.isSuccess(), "Create should succeed");
        assertNotNull(createRes.getId(), "Session ID should not be null");

        String sessionId = createRes.getId();
        System.out.println("  Created session with options: " + sessionId);

        // Clean up
        client.deleteBrowser(sessionId);

        System.out.println("✓ Browser create with options test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserExecuteBash() {
        System.out.println("Testing browser execute with bash...");

        // Create a session
        BrowserCreateResponse createRes = client.browser();
        assertTrue(createRes.isSuccess(), "Create should succeed");
        String sessionId = createRes.getId();

        try {
            // Execute bash code
            BrowserExecuteResponse execRes = client.browserExecute(sessionId, "echo 'hello from java sdk'");
            assertNotNull(execRes, "Execute response should not be null");
            assertTrue(execRes.isSuccess(), "Execute should succeed");
            assertNotNull(execRes.getStdout(), "Stdout should not be null");
            assertTrue(execRes.getStdout().contains("hello from java sdk"),
                    "Stdout should contain our echo output");

            System.out.println("  Stdout: " + execRes.getStdout().trim());
            System.out.println("  Exit code: " + execRes.getExitCode());
        } finally {
            // Clean up
            client.deleteBrowser(sessionId);
        }

        System.out.println("✓ Browser execute bash test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserExecuteNode() {
        System.out.println("Testing browser execute with node...");

        // Create a session
        BrowserCreateResponse createRes = client.browser();
        assertTrue(createRes.isSuccess(), "Create should succeed");
        String sessionId = createRes.getId();

        try {
            // Execute node code
            BrowserExecuteResponse execRes = client.browserExecute(
                    sessionId, "console.log(1 + 2)", "node", null);
            assertNotNull(execRes, "Execute response should not be null");
            assertTrue(execRes.isSuccess(), "Execute should succeed");

            System.out.println("  Stdout: " + (execRes.getStdout() != null ? execRes.getStdout().trim() : "null"));
        } finally {
            client.deleteBrowser(sessionId);
        }

        System.out.println("✓ Browser execute node test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserExecutePython() {
        System.out.println("Testing browser execute with python...");

        // Create a session
        BrowserCreateResponse createRes = client.browser();
        assertTrue(createRes.isSuccess(), "Create should succeed");
        String sessionId = createRes.getId();

        try {
            // Execute python code
            BrowserExecuteResponse execRes = client.browserExecute(
                    sessionId, "print('hello from python')", "python", null);
            assertNotNull(execRes, "Execute response should not be null");
            assertTrue(execRes.isSuccess(), "Execute should succeed");

            System.out.println("  Stdout: " + (execRes.getStdout() != null ? execRes.getStdout().trim() : "null"));
        } finally {
            client.deleteBrowser(sessionId);
        }

        System.out.println("✓ Browser execute python test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserExecuteWithTimeout() {
        System.out.println("Testing browser execute with custom timeout...");

        // Create a session
        BrowserCreateResponse createRes = client.browser();
        assertTrue(createRes.isSuccess(), "Create should succeed");
        String sessionId = createRes.getId();

        try {
            // Execute with custom timeout (60 seconds)
            BrowserExecuteResponse execRes = client.browserExecute(
                    sessionId, "echo 'timeout test'", "bash", 60);
            assertNotNull(execRes, "Execute response should not be null");
            assertTrue(execRes.isSuccess(), "Execute should succeed");

            System.out.println("  Stdout: " + (execRes.getStdout() != null ? execRes.getStdout().trim() : "null"));
        } finally {
            client.deleteBrowser(sessionId);
        }

        System.out.println("✓ Browser execute with timeout test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserListSessions() {
        System.out.println("Testing list browser sessions...");

        // List all sessions
        BrowserListResponse listRes = client.listBrowsers();
        assertNotNull(listRes, "List response should not be null");
        assertTrue(listRes.isSuccess(), "List should succeed");

        System.out.println("  Total sessions: " + (listRes.getSessions() != null ? listRes.getSessions().size() : 0));

        System.out.println("✓ List browser sessions test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserListActiveFilter() {
        System.out.println("Testing list browser sessions with active filter...");

        // Create a session so we have at least one active
        BrowserCreateResponse createRes = client.browser();
        assertTrue(createRes.isSuccess(), "Create should succeed");
        String sessionId = createRes.getId();

        try {
            // List only active sessions
            BrowserListResponse listRes = client.listBrowsers("active");
            assertNotNull(listRes, "List response should not be null");
            assertTrue(listRes.isSuccess(), "List should succeed");
            assertNotNull(listRes.getSessions(), "Sessions list should not be null");
            assertFalse(listRes.getSessions().isEmpty(), "Should have at least one active session");

            System.out.println("  Active sessions: " + listRes.getSessions().size());
        } finally {
            client.deleteBrowser(sessionId);
        }

        System.out.println("✓ List active browser sessions test passed");
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testBrowserFullLifecycle() {
        System.out.println("Testing full browser session lifecycle...");

        // 1. Create session
        BrowserCreateResponse createRes = client.browser(300, 120, true);
        assertTrue(createRes.isSuccess(), "Create should succeed");
        assertNotNull(createRes.getId(), "Should have session ID");
        String sessionId = createRes.getId();
        System.out.println("  1. Created session: " + sessionId);

        // CDP URL and live view URL may be present
        if (createRes.getCdpUrl() != null) {
            System.out.println("  CDP URL present: true");
        }
        if (createRes.getLiveViewUrl() != null) {
            System.out.println("  Live View URL present: true");
        }

        // 2. Navigate to a page
        BrowserExecuteResponse navRes = client.browserExecute(
                sessionId, "agent-browser open https://example.com", "bash", 30);
        assertTrue(navRes.isSuccess(), "Navigation should succeed");
        System.out.println("  2. Navigated to example.com");

        // 3. Take a snapshot
        BrowserExecuteResponse snapRes = client.browserExecute(
                sessionId, "agent-browser snapshot -i -c", "bash", 30);
        assertTrue(snapRes.isSuccess(), "Snapshot should succeed");
        System.out.println("  3. Took snapshot");

        // 4. Get page title
        BrowserExecuteResponse titleRes = client.browserExecute(
                sessionId, "agent-browser get title", "bash", 30);
        assertTrue(titleRes.isSuccess(), "Get title should succeed");
        System.out.println("  4. Page title: " + (titleRes.getStdout() != null ? titleRes.getStdout().trim() : "null"));

        // 5. Verify session is active
        BrowserListResponse listRes = client.listBrowsers("active");
        assertTrue(listRes.isSuccess(), "List should succeed");
        System.out.println("  5. Active sessions: " + (listRes.getSessions() != null ? listRes.getSessions().size() : 0));

        // 6. Delete session
        BrowserDeleteResponse deleteRes = client.deleteBrowser(sessionId);
        assertTrue(deleteRes.isSuccess(), "Delete should succeed");
        System.out.println("  6. Deleted session");
        if (deleteRes.getSessionDurationMs() != null) {
            System.out.println("  Session duration: " + deleteRes.getSessionDurationMs() + "ms");
        }
        if (deleteRes.getCreditsBilled() != null) {
            System.out.println("  Credits billed: " + deleteRes.getCreditsBilled());
        }

        System.out.println("✓ Full browser session lifecycle test passed");
    }

    @Test
    void testBrowserExecuteRequiresSessionId() {
        FirecrawlClient testClient = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();

        assertThrows(NullPointerException.class, () ->
                testClient.browserExecute(null, "echo test")
        );
    }

    @Test
    void testBrowserExecuteRequiresCode() {
        FirecrawlClient testClient = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();

        assertThrows(NullPointerException.class, () ->
                testClient.browserExecute("some-session-id", null)
        );
    }

    @Test
    void testBrowserDeleteRequiresSessionId() {
        FirecrawlClient testClient = FirecrawlClient.builder()
                .apiKey("fc-test-key")
                .build();

        assertThrows(NullPointerException.class, () ->
                testClient.deleteBrowser(null)
        );
    }
}
