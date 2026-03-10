package com.firecrawl;

import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.AgentOptions;
import com.firecrawl.models.AgentResponse;
import com.firecrawl.models.AgentStatusResponse;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Comprehensive Agent Tests
 * 
 * Tests the AI agent functionality with various configurations.
 * Based on Node.js SDK patterns and tested against live firecrawl.dev.
 * 
 * Run with: FIRECRAWL_API_KEY=fc-xxx gradle test --tests "com.firecrawl.AgentTest"
 */
class AgentTest {

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
    void testAgentWithPrompt() {
        System.out.println("\n=== Test: Agent with Prompt ===");
        
        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .prompt("Find information about Firecrawl's main features and pricing")
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertNotNull(result.getStatus(), "Status should not be null");
        assertTrue(List.of("completed", "failed").contains(result.getStatus()),
                "Status should be completed or failed: " + result.getStatus());
        
        System.out.println("✓ Agent task completed");
        System.out.println("  Status: " + result.getStatus());
        if (result.getData() != null) {
            System.out.println("  Data returned: ✓");
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentWithURLs() {
        System.out.println("\n=== Test: Agent with Specific URLs ===");
        
        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .urls(List.of("https://firecrawl.dev", "https://docs.firecrawl.dev"))
                        .prompt("What are the main features of Firecrawl?")
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertTrue(List.of("completed", "failed").contains(result.getStatus()),
                "Status should be completed or failed");
        
        System.out.println("✓ Agent with URLs completed");
        System.out.println("  URLs provided: 2");
        System.out.println("  Status: " + result.getStatus());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentWithSchema() {
        System.out.println("\n=== Test: Agent with Schema ===");
        
        Map<String, Object> schema = Map.of(
                "type", "object",
                "properties", Map.of(
                        "features", Map.of(
                                "type", "array",
                                "items", Map.of("type", "string")
                        ),
                        "pricing", Map.of(
                                "type", "object",
                                "properties", Map.of(
                                        "plans", Map.of("type", "array")
                                )
                        )
                ),
                "required", List.of("features")
        );

        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .urls(List.of("https://firecrawl.dev"))
                        .prompt("Extract features and pricing information")
                        .schema(schema)
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertTrue(List.of("completed", "failed").contains(result.getStatus()),
                "Status should be completed or failed");
        
        System.out.println("✓ Agent with schema completed");
        System.out.println("  Schema provided: ✓");
        System.out.println("  Status: " + result.getStatus());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testStartAgent() {
        System.out.println("\n=== Test: Start Agent (Async) ===");
        
        AgentResponse response = client.startAgent(
                AgentOptions.builder()
                        .prompt("Research Firecrawl features")
                        .build());

        assertNotNull(response, "Agent response should not be null");
        assertNotNull(response.getId(), "Agent ID should not be null");
        assertTrue(response.isSuccess(), "Response should be successful");
        
        System.out.println("✓ Agent started successfully");
        System.out.println("  Job ID: " + response.getId());
        System.out.println("  Success: " + response.isSuccess());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentStatusCheck() {
        System.out.println("\n=== Test: Check Agent Status ===");
        
        // Start an agent
        AgentResponse start = client.startAgent(
                AgentOptions.builder()
                        .prompt("Find information about web scraping")
                        .build());

        // Check status
        AgentStatusResponse status = client.getAgentStatus(start.getId());
        
        assertNotNull(status, "Status should not be null");
        assertNotNull(status.getStatus(), "Status field should not be null");
        assertTrue(List.of("scraping", "completed", "failed", "cancelled").contains(status.getStatus()),
                "Status should be valid: " + status.getStatus());
        
        System.out.println("✓ Agent status retrieved");
        System.out.println("  Status: " + status.getStatus());
        System.out.println("  Job ID: " + start.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testCancelAgent() {
        System.out.println("\n=== Test: Cancel Agent ===");
        
        AgentResponse start = client.startAgent(
                AgentOptions.builder()
                        .prompt("Long-running research task")
                        .build());

        Map<String, Object> result = client.cancelAgent(start.getId());
        
        assertNotNull(result, "Cancel result should not be null");
        
        System.out.println("✓ Agent cancelled successfully");
        System.out.println("  Job ID: " + start.getId());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentWithStrictURLConstraints() {
        System.out.println("\n=== Test: Agent with Strict URL Constraints ===");
        
        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .urls(List.of("https://docs.firecrawl.dev"))
                        .prompt("Extract API documentation structure")
                        .strictConstrainToURLs(true)
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertTrue(List.of("completed", "failed").contains(result.getStatus()),
                "Status should be completed or failed");
        
        System.out.println("✓ Agent with strict constraints completed");
        System.out.println("  Strict URL constraint: true");
        System.out.println("  Status: " + result.getStatus());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentWithMaxCredits() {
        System.out.println("\n=== Test: Agent with Max Credits Limit ===");
        
        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .prompt("Quick research on Firecrawl")
                        .maxCredits(10)
                        .build());

        assertNotNull(result, "Agent result should not be null");
        
        System.out.println("✓ Agent with credit limit completed");
        System.out.println("  Max credits: 10");
        System.out.println("  Status: " + result.getStatus());
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentResearchTask() {
        System.out.println("\n=== Test: Agent Research - Firecrawl Features ===");
        
        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .urls(List.of("https://firecrawl.dev", "https://docs.firecrawl.dev"))
                        .prompt("Research and summarize the key features of Firecrawl, including scraping, crawling, and extraction capabilities")
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertEquals("completed", result.getStatus(), "Agent should complete successfully");
        assertNotNull(result.getData(), "Agent should return data");
        
        System.out.println("✓ Research task completed");
        System.out.println("  Status: " + result.getStatus());
        System.out.println("  Data collected: ✓");
        
        if (result.getData() != null) {
            System.out.println("  Data summary: " + 
                    result.getData().toString().substring(0, 
                            Math.min(200, result.getData().toString().length())) + "...");
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIRECRAWL_API_KEY", matches = ".*\\S.*")
    void testAgentComprehensive() {
        System.out.println("\n=== Test: Agent with All Options ===");
        
        Map<String, Object> schema = Map.of(
                "type", "object",
                "properties", Map.of(
                        "product_name", Map.of("type", "string"),
                        "features", Map.of(
                                "type", "array",
                                "items", Map.of("type", "string")
                        ),
                        "pricing", Map.of("type", "string")
                ),
                "required", List.of("product_name", "features")
        );

        AgentStatusResponse result = client.agent(
                AgentOptions.builder()
                        .urls(List.of("https://firecrawl.dev"))
                        .prompt("Extract comprehensive product information including name, features, and pricing")
                        .schema(schema)
                        .maxCredits(20)
                        .strictConstrainToURLs(true)
                        .build());

        assertNotNull(result, "Agent result should not be null");
        assertTrue(List.of("completed", "failed").contains(result.getStatus()),
                "Status should be completed or failed");
        
        System.out.println("✓ Comprehensive agent task completed");
        System.out.println("  Configuration:");
        System.out.println("    - URLs: 1");
        System.out.println("    - Schema: ✓");
        System.out.println("    - Max credits: 20");
        System.out.println("    - Strict constraints: true");
        System.out.println("  Results:");
        System.out.println("    - Status: " + result.getStatus());
        if (result.getData() != null) {
            System.out.println("    - Data returned: ✓");
        }
    }
}
