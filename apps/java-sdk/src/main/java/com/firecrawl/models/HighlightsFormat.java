package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Highlights format for extracting direct highlights from page content.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class HighlightsFormat {

    private final String type = "highlights";
    private String query;

    private HighlightsFormat() {}

    public String getType() { return type; }
    public String getQuery() { return query; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String query;

        private Builder() {}

        /** Query used to select highlights from the page content. */
        public Builder query(String query) { this.query = query; return this; }

        public HighlightsFormat build() {
            HighlightsFormat f = new HighlightsFormat();
            f.query = this.query;
            return f;
        }
    }
}
