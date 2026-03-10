package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * Webhook configuration for async jobs.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class WebhookConfig {

    private String url;
    private Map<String, String> headers;
    private Map<String, String> metadata;
    private List<String> events;

    private WebhookConfig() {}

    public String getUrl() { return url; }
    public Map<String, String> getHeaders() { return headers; }
    public Map<String, String> getMetadata() { return metadata; }
    public List<String> getEvents() { return events; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String url;
        private Map<String, String> headers;
        private Map<String, String> metadata;
        private List<String> events;

        private Builder() {}

        public Builder url(String url) { this.url = url; return this; }
        public Builder headers(Map<String, String> headers) { this.headers = headers; return this; }
        public Builder metadata(Map<String, String> metadata) { this.metadata = metadata; return this; }

        /**
         * Events to subscribe to. Crawl/batch events: "completed", "failed", "page", "started".
         * Agent events: "started", "action", "completed", "failed", "cancelled".
         */
        public Builder events(List<String> events) { this.events = events; return this; }

        public WebhookConfig build() {
            if (url == null || url.isEmpty()) {
                throw new IllegalArgumentException("Webhook URL is required");
            }
            WebhookConfig c = new WebhookConfig();
            c.url = this.url;
            c.headers = this.headers;
            c.metadata = this.metadata;
            c.events = this.events;
            return c;
        }
    }
}
