package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * JSON extraction format with optional schema and prompt.
 *
 * <p>Usage:
 * <pre>{@code
 * JsonFormat jsonFmt = JsonFormat.builder()
 *     .prompt("Extract the product name and price")
 *     .schema(Map.of(
 *         "type", "object",
 *         "properties", Map.of(
 *             "name", Map.of("type", "string"),
 *             "price", Map.of("type", "number")
 *         )
 *     ))
 *     .build();
 * }</pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class JsonFormat {

    private final String type = "json";
    private String prompt;
    private Map<String, Object> schema;

    private JsonFormat() {}

    public String getType() { return type; }
    public String getPrompt() { return prompt; }
    public Map<String, Object> getSchema() { return schema; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String prompt;
        private Map<String, Object> schema;

        private Builder() {}

        /** LLM prompt for extraction. */
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }

        /** JSON Schema for structured extraction. */
        public Builder schema(Map<String, Object> schema) { this.schema = schema; return this; }

        public JsonFormat build() {
            JsonFormat f = new JsonFormat();
            f.prompt = this.prompt;
            f.schema = this.schema;
            return f;
        }
    }
}
