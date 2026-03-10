package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Options for mapping (discovering URLs on) a website.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class MapOptions {

    private String search;
    private String sitemap;
    private Boolean includeSubdomains;
    private Boolean ignoreQueryParameters;
    private Integer limit;
    private Integer timeout;
    private String integration;
    private LocationConfig location;

    private MapOptions() {}

    public String getSearch() { return search; }
    /** Sitemap mode: "only", "include", or "skip". */
    public String getSitemap() { return sitemap; }
    public Boolean getIncludeSubdomains() { return includeSubdomains; }
    public Boolean getIgnoreQueryParameters() { return ignoreQueryParameters; }
    public Integer getLimit() { return limit; }
    public Integer getTimeout() { return timeout; }
    public String getIntegration() { return integration; }
    public LocationConfig getLocation() { return location; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String search;
        private String sitemap;
        private Boolean includeSubdomains;
        private Boolean ignoreQueryParameters;
        private Integer limit;
        private Integer timeout;
        private String integration;
        private LocationConfig location;

        private Builder() {}

        /** Filter discovered URLs by keyword. */
        public Builder search(String search) { this.search = search; return this; }
        /** Sitemap mode: "only", "include", or "skip". */
        public Builder sitemap(String sitemap) { this.sitemap = sitemap; return this; }
        /** Include subdomains. */
        public Builder includeSubdomains(Boolean includeSubdomains) { this.includeSubdomains = includeSubdomains; return this; }
        /** Ignore query parameters when deduplicating URLs. */
        public Builder ignoreQueryParameters(Boolean ignoreQueryParameters) { this.ignoreQueryParameters = ignoreQueryParameters; return this; }
        /** Maximum number of URLs to return. */
        public Builder limit(Integer limit) { this.limit = limit; return this; }
        /** Timeout in milliseconds. */
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }
        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }
        /** Geolocation configuration. */
        public Builder location(LocationConfig location) { this.location = location; return this; }

        public MapOptions build() {
            MapOptions o = new MapOptions();
            o.search = this.search;
            o.sitemap = this.sitemap;
            o.includeSubdomains = this.includeSubdomains;
            o.ignoreQueryParameters = this.ignoreQueryParameters;
            o.limit = this.limit;
            o.timeout = this.timeout;
            o.integration = this.integration;
            o.location = this.location;
            return o;
        }
    }
}
