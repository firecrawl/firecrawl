package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Deprecated query format for asking a question about page content.
 *
 * @deprecated Use {@link QuestionFormat} or {@link HighlightsFormat} instead.
 */
@Deprecated
@JsonInclude(JsonInclude.Include.NON_NULL)
public class QueryFormat {

    public enum Mode {
        FREEFORM("freeform"),
        DIRECT_QUOTE("directQuote");

        private final String value;

        Mode(String value) {
            this.value = value;
        }

        @JsonValue
        public String getValue() {
            return value;
        }
    }

    private final String type = "query";
    private String prompt;
    private Mode mode;

    private QueryFormat() {}

    public String getType() { return type; }
    public String getPrompt() { return prompt; }
    public Mode getMode() { return mode; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String prompt;
        private Mode mode;

        private Builder() {}

        /** Question to answer from the page content. */
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }

        /** Query answer mode: freeform or direct quote. */
        public Builder mode(Mode mode) { this.mode = mode; return this; }

        public QueryFormat build() {
            QueryFormat f = new QueryFormat();
            f.prompt = this.prompt;
            f.mode = this.mode;
            return f;
        }
    }
}
