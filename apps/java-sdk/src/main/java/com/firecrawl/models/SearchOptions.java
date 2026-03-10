package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Options for a web search request.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SearchOptions {

    private List<Object> sources;
    private List<Object> categories;
    private Integer limit;
    private String tbs;
    private String location;
    private Boolean ignoreInvalidURLs;
    private Integer timeout;
    private ScrapeOptions scrapeOptions;
    private String integration;

    private SearchOptions() {}

    public List<Object> getSources() { return sources; }
    public List<Object> getCategories() { return categories; }
    public Integer getLimit() { return limit; }
    public String getTbs() { return tbs; }
    public String getLocation() { return location; }
    public Boolean getIgnoreInvalidURLs() { return ignoreInvalidURLs; }
    public Integer getTimeout() { return timeout; }
    public ScrapeOptions getScrapeOptions() { return scrapeOptions; }
    public String getIntegration() { return integration; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private List<Object> sources;
        private List<Object> categories;
        private Integer limit;
        private String tbs;
        private String location;
        private Boolean ignoreInvalidURLs;
        private Integer timeout;
        private ScrapeOptions scrapeOptions;
        private String integration;

        private Builder() {}

        /** Source types: "web", "news", "images" as strings or {type: "web"} maps. */
        public Builder sources(List<Object> sources) { this.sources = sources; return this; }
        /** Categories: "github", "research", "pdf". */
        public Builder categories(List<Object> categories) { this.categories = categories; return this; }
        /** Maximum number of results. */
        public Builder limit(Integer limit) { this.limit = limit; return this; }
        /** Time-based search filter (e.g., "qdr:d" for past day, "qdr:w" for past week). */
        public Builder tbs(String tbs) { this.tbs = tbs; return this; }
        /** Location for search results (e.g., "US"). */
        public Builder location(String location) { this.location = location; return this; }
        /** Ignore invalid URLs in results. */
        public Builder ignoreInvalidURLs(Boolean ignoreInvalidURLs) { this.ignoreInvalidURLs = ignoreInvalidURLs; return this; }
        /** Timeout in milliseconds. */
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }
        /** Scrape options applied to search result pages. */
        public Builder scrapeOptions(ScrapeOptions scrapeOptions) { this.scrapeOptions = scrapeOptions; return this; }
        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }

        public SearchOptions build() {
            SearchOptions o = new SearchOptions();
            o.sources = this.sources;
            o.categories = this.categories;
            o.limit = this.limit;
            o.tbs = this.tbs;
            o.location = this.location;
            o.ignoreInvalidURLs = this.ignoreInvalidURLs;
            o.timeout = this.timeout;
            o.scrapeOptions = this.scrapeOptions;
            o.integration = this.integration;
            return o;
        }
    }
}
