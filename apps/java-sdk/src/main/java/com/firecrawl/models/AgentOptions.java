package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * Options for starting an agent task.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AgentOptions {

    private List<String> urls;
    private String prompt;
    private Map<String, Object> schema;
    private String integration;
    private Integer maxCredits;
    private Boolean strictConstrainToURLs;
    private String model;
    private WebhookConfig webhook;

    private AgentOptions() {}

    public List<String> getUrls() { return urls; }
    public String getPrompt() { return prompt; }
    public Map<String, Object> getSchema() { return schema; }
    public String getIntegration() { return integration; }
    public Integer getMaxCredits() { return maxCredits; }
    public Boolean getStrictConstrainToURLs() { return strictConstrainToURLs; }
    public String getModel() { return model; }
    public WebhookConfig getWebhook() { return webhook; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private List<String> urls;
        private String prompt;
        private Map<String, Object> schema;
        private String integration;
        private Integer maxCredits;
        private Boolean strictConstrainToURLs;
        private String model;
        private WebhookConfig webhook;

        private Builder() {}

        /** Optional URLs to constrain the agent to. */
        public Builder urls(List<String> urls) { this.urls = urls; return this; }
        /** Natural language prompt describing what data to find. */
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        /** JSON Schema for structured output. */
        public Builder schema(Map<String, Object> schema) { this.schema = schema; return this; }
        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }
        /** Maximum credits to spend. */
        public Builder maxCredits(Integer maxCredits) { this.maxCredits = maxCredits; return this; }
        /** Don't navigate outside provided URLs. */
        public Builder strictConstrainToURLs(Boolean strictConstrainToURLs) { this.strictConstrainToURLs = strictConstrainToURLs; return this; }
        /** Agent model: "spark-1-pro" or "spark-1-mini". */
        public Builder model(String model) { this.model = model; return this; }
        /** Webhook configuration. */
        public Builder webhook(WebhookConfig webhook) { this.webhook = webhook; return this; }

        public AgentOptions build() {
            if (prompt == null || prompt.isEmpty()) {
                throw new IllegalArgumentException("Agent prompt is required");
            }
            AgentOptions o = new AgentOptions();
            o.urls = this.urls;
            o.prompt = this.prompt;
            o.schema = this.schema;
            o.integration = this.integration;
            o.maxCredits = this.maxCredits;
            o.strictConstrainToURLs = this.strictConstrainToURLs;
            o.model = this.model;
            o.webhook = this.webhook;
            return o;
        }
    }
}
