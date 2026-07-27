package com.firecrawl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.AgentOptions;
import com.firecrawl.models.AuditMetadata;
import com.firecrawl.models.MapOptions;
import com.firecrawl.models.ParseOptions;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class AuditMetadataTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serializesAuditMetadataAcrossRequestOptions() {
        AuditMetadata metadata = new AuditMetadata("alice@example.com");

        assertAuditMetadata(ScrapeOptions.builder().auditMetadata(metadata).build());
        assertAuditMetadata(MapOptions.builder().auditMetadata(metadata).build());
        assertAuditMetadata(AgentOptions.builder().prompt("find pricing").auditMetadata(metadata).build());
        assertAuditMetadata(ParseOptions.builder().auditMetadata(metadata).build());
    }

    private void assertAuditMetadata(Object options) {
        Map<?, ?> body = mapper.convertValue(options, Map.class);
        assertEquals(Map.of("username", "alice@example.com"), body.get("auditMetadata"));
    }
}
