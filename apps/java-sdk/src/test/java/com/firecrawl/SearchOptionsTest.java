package com.firecrawl;

import com.firecrawl.models.SearchOptions;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;

class SearchOptionsTest {
    @Test
    void exposesHighlightsOption() {
        SearchOptions options = SearchOptions.builder().highlights(false).build();

        assertFalse(options.getHighlights());
    }
}
