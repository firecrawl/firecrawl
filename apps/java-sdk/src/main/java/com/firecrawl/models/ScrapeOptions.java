package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Options for scraping a single URL.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ScrapeOptions {

    private List<Object> formats;
    private Map<String, String> headers;
    private List<String> includeTags;
    private List<String> excludeTags;
    private Boolean onlyMainContent;
    private Integer timeout;
    private Integer waitFor;
    private Boolean mobile;
    private List<Object> parsers;
    private List<Map<String, Object>> actions;
    private LocationConfig location;
    private Boolean skipTlsVerification;
    private Boolean removeBase64Images;
    private Boolean blockAds;
    private String proxy;
    @JsonProperty("maxAge")
    private Long maxAge;
    private Boolean storeInCache;
    private String integration;

    private ScrapeOptions() {}

    public List<Object> getFormats() { return formats; }
    public Map<String, String> getHeaders() { return headers; }
    public List<String> getIncludeTags() { return includeTags; }
    public List<String> getExcludeTags() { return excludeTags; }
    public Boolean getOnlyMainContent() { return onlyMainContent; }
    public Integer getTimeout() { return timeout; }
    public Integer getWaitFor() { return waitFor; }
    public Boolean getMobile() { return mobile; }
    public List<Object> getParsers() { return parsers; }
    public List<Map<String, Object>> getActions() { return actions; }
    public LocationConfig getLocation() { return location; }
    public Boolean getSkipTlsVerification() { return skipTlsVerification; }
    public Boolean getRemoveBase64Images() { return removeBase64Images; }
    public Boolean getBlockAds() { return blockAds; }
    public String getProxy() { return proxy; }
    public Long getMaxAge() { return maxAge; }
    public Boolean getStoreInCache() { return storeInCache; }
    public String getIntegration() { return integration; }

    public static Builder builder() { return new Builder(); }

    public Builder toBuilder() {
        Builder b = new Builder();
        b.formats = this.formats != null ? new ArrayList<>(this.formats) : null;
        b.headers = this.headers != null ? new HashMap<>(this.headers) : null;
        b.includeTags = this.includeTags != null ? new ArrayList<>(this.includeTags) : null;
        b.excludeTags = this.excludeTags != null ? new ArrayList<>(this.excludeTags) : null;
        b.onlyMainContent = this.onlyMainContent;
        b.timeout = this.timeout;
        b.waitFor = this.waitFor;
        b.mobile = this.mobile;
        b.parsers = this.parsers != null ? new ArrayList<>(this.parsers) : null;
        b.actions = this.actions != null ? new ArrayList<>(this.actions) : null;
        b.location = this.location;
        b.skipTlsVerification = this.skipTlsVerification;
        b.removeBase64Images = this.removeBase64Images;
        b.blockAds = this.blockAds;
        b.proxy = this.proxy;
        b.maxAge = this.maxAge;
        b.storeInCache = this.storeInCache;
        b.integration = this.integration;
        return b;
    }

    public static final class Builder {
        private List<Object> formats;
        private Map<String, String> headers;
        private List<String> includeTags;
        private List<String> excludeTags;
        private Boolean onlyMainContent;
        private Integer timeout;
        private Integer waitFor;
        private Boolean mobile;
        private List<Object> parsers;
        private List<Map<String, Object>> actions;
        private LocationConfig location;
        private Boolean skipTlsVerification;
        private Boolean removeBase64Images;
        private Boolean blockAds;
        private String proxy;
        private Long maxAge;
        private Boolean storeInCache;
        private String integration;

        private Builder() {}

        /**
         * Output formats to request. Accepts strings like "markdown", "html", "rawHtml",
         * "links", "screenshot", "json", etc., or format configuration maps for advanced
         * formats (e.g., JsonFormat, ScreenshotFormat).
         */
        public Builder formats(List<Object> formats) { this.formats = formats; return this; }

        /** Custom HTTP headers to send with the request. */
        public Builder headers(Map<String, String> headers) { this.headers = headers; return this; }

        /** Only include content from these HTML tags. */
        public Builder includeTags(List<String> includeTags) { this.includeTags = includeTags; return this; }

        /** Exclude content from these HTML tags. */
        public Builder excludeTags(List<String> excludeTags) { this.excludeTags = excludeTags; return this; }

        /** Only return the main content of the page, excluding navbars/footers. */
        public Builder onlyMainContent(Boolean onlyMainContent) { this.onlyMainContent = onlyMainContent; return this; }

        /** Timeout in milliseconds for the scrape request. */
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }

        /** Wait time in milliseconds before scraping (for JS rendering). */
        public Builder waitFor(Integer waitFor) { this.waitFor = waitFor; return this; }

        /** Scrape as a mobile device. */
        public Builder mobile(Boolean mobile) { this.mobile = mobile; return this; }

        /** Parsers to use (e.g., "pdf" or {"type": "pdf", "maxPages": 10}). */
        public Builder parsers(List<Object> parsers) { this.parsers = parsers; return this; }

        /** Actions to execute before/during scraping. */
        public Builder actions(List<Map<String, Object>> actions) { this.actions = actions; return this; }

        /** Geolocation configuration. */
        public Builder location(LocationConfig location) { this.location = location; return this; }

        /** Skip TLS certificate verification. */
        public Builder skipTlsVerification(Boolean skipTlsVerification) { this.skipTlsVerification = skipTlsVerification; return this; }

        /** Remove base64-encoded images from the response. */
        public Builder removeBase64Images(Boolean removeBase64Images) { this.removeBase64Images = removeBase64Images; return this; }

        /** Block advertisements during scraping. */
        public Builder blockAds(Boolean blockAds) { this.blockAds = blockAds; return this; }

        /** Proxy mode: "basic", "stealth", "enhanced", "auto", or a custom proxy URL. */
        public Builder proxy(String proxy) { this.proxy = proxy; return this; }

        /** Use cached result if younger than this many milliseconds. */
        public Builder maxAge(Long maxAge) { this.maxAge = maxAge; return this; }

        /** Whether to cache the result. */
        public Builder storeInCache(Boolean storeInCache) { this.storeInCache = storeInCache; return this; }

        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }

        public ScrapeOptions build() {
            ScrapeOptions o = new ScrapeOptions();
            o.formats = this.formats != null ? Collections.unmodifiableList(new ArrayList<>(this.formats)) : null;
            o.headers = this.headers != null ? Collections.unmodifiableMap(new HashMap<>(this.headers)) : null;
            o.includeTags = this.includeTags != null ? Collections.unmodifiableList(new ArrayList<>(this.includeTags)) : null;
            o.excludeTags = this.excludeTags != null ? Collections.unmodifiableList(new ArrayList<>(this.excludeTags)) : null;
            o.onlyMainContent = this.onlyMainContent;
            o.timeout = this.timeout;
            o.waitFor = this.waitFor;
            o.mobile = this.mobile;
            o.parsers = this.parsers != null ? Collections.unmodifiableList(new ArrayList<>(this.parsers)) : null;
            o.actions = this.actions != null ? Collections.unmodifiableList(new ArrayList<>(this.actions)) : null;
            o.location = this.location;
            o.skipTlsVerification = this.skipTlsVerification;
            o.removeBase64Images = this.removeBase64Images;
            o.blockAds = this.blockAds;
            o.proxy = this.proxy;
            o.maxAge = this.maxAge;
            o.storeInCache = this.storeInCache;
            o.integration = this.integration;
            return o;
        }
    }
}
