package com.firecrawl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.AgentOptions;
import com.firecrawl.models.MapOptions;
import com.firecrawl.models.ParseOptions;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AuditMetadataTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serializesAuditMetadataAcrossRequestOptions() {
        Map<String, String> metadata = Map.of("requestId", "req-123");

        assertAuditMetadata(ScrapeOptions.builder().auditMetadata(metadata).build());
        assertAuditMetadata(MapOptions.builder().auditMetadata(metadata).build());
        assertAuditMetadata(AgentOptions.builder().prompt("find pricing").auditMetadata(metadata).build());
        assertAuditMetadata(ParseOptions.builder().auditMetadata(metadata).build());
    }

    @Test
    void mapAndAgentOptionsDefensivelyCopyAuditMetadata() {
        Map<String, String> metadata = new HashMap<>();
        metadata.put("requestId", "req-123");

        MapOptions map = MapOptions.builder().auditMetadata(metadata).build();
        AgentOptions agent = AgentOptions.builder()
                .prompt("find pricing")
                .auditMetadata(metadata)
                .build();
        metadata.put("requestId", "mutated");

        assertEquals("req-123", map.getAuditMetadata().get("requestId"));
        assertEquals("req-123", agent.getAuditMetadata().get("requestId"));
        assertThrows(UnsupportedOperationException.class,
                () -> map.getAuditMetadata().put("requestId", "mutated"));
        assertThrows(UnsupportedOperationException.class,
                () -> agent.getAuditMetadata().put("requestId", "mutated"));
    }

    private void assertAuditMetadata(Object options) {
        Map<?, ?> body = mapper.convertValue(options, Map.class);
        assertEquals(Map.of("requestId", "req-123"), body.get("auditMetadata"));
    }
}
