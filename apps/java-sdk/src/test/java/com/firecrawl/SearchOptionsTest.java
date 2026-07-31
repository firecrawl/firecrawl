package com.firecrawl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.firecrawl.models.SearchOptions;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SearchOptionsTest {
    @Test
    void serializesHighlightsOption() {
        ObjectMapper mapper = new ObjectMapper();
        JsonNode enabled = mapper.valueToTree(
                SearchOptions.builder().highlights(true).build());
        JsonNode disabled = mapper.valueToTree(
                SearchOptions.builder().highlights(false).build());
        JsonNode omitted = mapper.valueToTree(SearchOptions.builder().build());

        assertTrue(enabled.get("highlights").asBoolean());
        assertFalse(disabled.get("highlights").asBoolean());
        assertFalse(omitted.has("highlights"));
    }
}
