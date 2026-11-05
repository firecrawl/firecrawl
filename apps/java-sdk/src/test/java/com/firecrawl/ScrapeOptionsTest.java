package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.ScrapeOptions;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ScrapeOptionsTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serializesMinAgeOption() {
        JsonNode set = mapper.valueToTree(ScrapeOptions.builder().minAge(3600000L).build());
        JsonNode omitted = mapper.valueToTree(ScrapeOptions.builder().build());

        assertEquals(3600000L, set.get("minAge").asLong());
        assertFalse(omitted.has("minAge"));
    }

    @Test
    void serializesZeroDataRetentionOption() {
        JsonNode enabled = mapper.valueToTree(ScrapeOptions.builder().zeroDataRetention(true).build());
        JsonNode disabled = mapper.valueToTree(ScrapeOptions.builder().zeroDataRetention(false).build());
        JsonNode omitted = mapper.valueToTree(ScrapeOptions.builder().build());

        assertTrue(enabled.get("zeroDataRetention").asBoolean());
        assertFalse(disabled.get("zeroDataRetention").asBoolean());
        assertFalse(omitted.has("zeroDataRetention"));
    }

    @Test
    void toBuilderKeepsMinAgeAndZeroDataRetention() {
        ScrapeOptions options = ScrapeOptions.builder()
                .minAge(3600000L)
                .zeroDataRetention(true)
                .build()
                .toBuilder()
                .build();

        assertEquals(Long.valueOf(3600000L), options.getMinAge());
        assertTrue(options.getZeroDataRetention());
    }
}
