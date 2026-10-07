package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
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
    private String effort;
    private WebhookConfig webhook;
    private AuditMetadata auditMetadata;
    private String threadId;
    private String mode;
    private AgentExchangeOptions exchange;

    private AgentOptions() {}

    public List<String> getUrls() { return urls; }
    public String getPrompt() { return prompt; }
    public Map<String, Object> getSchema() { return schema; }
    public String getIntegration() { return integration; }
    public Integer getMaxCredits() { return maxCredits; }
    public Boolean getStrictConstrainToURLs() { return strictConstrainToURLs; }
    public String getModel() { return model; }
    public String getEffort() { return effort; }
    public WebhookConfig getWebhook() { return webhook; }
    @JsonProperty("auditMetadata")
    public AuditMetadata getAuditMetadata() { return auditMetadata; }
    public String getThreadId() { return threadId; }
    public String getMode() { return mode; }
    public AgentExchangeOptions getExchange() { return exchange; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private List<String> urls;
        private String prompt;
        private Map<String, Object> schema;
        private String integration;
        private Integer maxCredits;
        private Boolean strictConstrainToURLs;
        private String model;
        private String effort;
        private WebhookConfig webhook;
        private AuditMetadata auditMetadata;
        private String threadId;
        private String mode;
        private AgentExchangeOptions exchange;

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
        /** Agent model: "spark-2" (default). "spark-1-pro" and "spark-1-mini" are deprecated and run spark-2. */
        public Builder model(String model) { this.model = model; return this; }
        /** Reasoning effort: "low", "medium", or "high". Sets the reasoning budget (every level runs spark-2). */
        public Builder effort(String effort) { this.effort = effort; return this; }
        /** Webhook configuration. */
        public Builder webhook(WebhookConfig webhook) { this.webhook = webhook; return this; }
        /** User attribution to include with SIEM logging events. */
        public Builder auditMetadata(AuditMetadata auditMetadata) { this.auditMetadata = auditMetadata; return this; }
        /** Run as the next turn of this thread. Omitted starts a new thread. */
        public Builder threadId(String threadId) { this.threadId = threadId; return this; }
        /** Run mode: "extract" (server default) or "chat". */
        public Builder mode(String mode) { this.mode = mode; return this; }
        /** Exchange (Alexandria data provider) settings. Omitted on a follow-up turn inherits the previous turn's. */
        public Builder exchange(AgentExchangeOptions exchange) { this.exchange = exchange; return this; }

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
            o.effort = this.effort;
            o.webhook = this.webhook;
            o.auditMetadata = this.auditMetadata;
            o.threadId = this.threadId;
            o.mode = this.mode;
            o.exchange = this.exchange;
            return o;
        }
    }
}
