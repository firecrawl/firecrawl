package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Options for a batch scrape job.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class BatchScrapeOptions {

    private ScrapeOptions options;
    private Object webhook;
    private String appendToId;
    private Boolean ignoreInvalidURLs;
    private Integer maxConcurrency;
    private Boolean zeroDataRetention;
    @JsonIgnore
    private String idempotencyKey;
    private String integration;

    private BatchScrapeOptions() {}

    public ScrapeOptions getOptions() { return options; }
    public Object getWebhook() { return webhook; }
    public String getAppendToId() { return appendToId; }
    public Boolean getIgnoreInvalidURLs() { return ignoreInvalidURLs; }
    public Integer getMaxConcurrency() { return maxConcurrency; }
    public Boolean getZeroDataRetention() { return zeroDataRetention; }
    @JsonIgnore
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getIntegration() { return integration; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private ScrapeOptions options;
        private Object webhook;
        private String appendToId;
        private Boolean ignoreInvalidURLs;
        private Integer maxConcurrency;
        private Boolean zeroDataRetention;
        private String idempotencyKey;
        private String integration;

        private Builder() {}

        /** Scrape options applied to each URL. */
        public Builder options(ScrapeOptions options) { this.options = options; return this; }
        /** Webhook URL string or {@link WebhookConfig} object. */
        public Builder webhook(Object webhook) { this.webhook = webhook; return this; }
        /** Append URLs to an existing batch job. */
        public Builder appendToId(String appendToId) { this.appendToId = appendToId; return this; }
        /** Ignore invalid URLs instead of failing. */
        public Builder ignoreInvalidURLs(Boolean ignoreInvalidURLs) { this.ignoreInvalidURLs = ignoreInvalidURLs; return this; }
        /** Max concurrent scrapes. */
        public Builder maxConcurrency(Integer maxConcurrency) { this.maxConcurrency = maxConcurrency; return this; }
        /** Do not store any data on Firecrawl servers. */
        public Builder zeroDataRetention(Boolean zeroDataRetention) { this.zeroDataRetention = zeroDataRetention; return this; }
        /** Idempotency key to prevent duplicate batch jobs. */
        public Builder idempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; return this; }
        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }

        public BatchScrapeOptions build() {
            BatchScrapeOptions o = new BatchScrapeOptions();
            o.options = this.options;
            o.webhook = this.webhook;
            o.appendToId = this.appendToId;
            o.ignoreInvalidURLs = this.ignoreInvalidURLs;
            o.maxConcurrency = this.maxConcurrency;
            o.zeroDataRetention = this.zeroDataRetention;
            o.idempotencyKey = this.idempotencyKey;
            o.integration = this.integration;
            return o;
        }
    }
}
