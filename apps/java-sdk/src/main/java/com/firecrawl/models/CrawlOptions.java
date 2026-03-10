package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * Options for crawling a website.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class CrawlOptions {

    private String prompt;
    private List<String> excludePaths;
    private List<String> includePaths;
    private Integer maxDiscoveryDepth;
    private String sitemap;
    private Boolean ignoreQueryParameters;
    private Boolean deduplicateSimilarURLs;
    private Integer limit;
    private Boolean crawlEntireDomain;
    private Boolean allowExternalLinks;
    private Boolean allowSubdomains;
    private Integer delay;
    private Integer maxConcurrency;
    private Object webhook;
    private ScrapeOptions scrapeOptions;
    private Boolean regexOnFullURL;
    private Boolean zeroDataRetention;
    private String integration;

    private CrawlOptions() {}

    public String getPrompt() { return prompt; }
    public List<String> getExcludePaths() { return excludePaths; }
    public List<String> getIncludePaths() { return includePaths; }
    public Integer getMaxDiscoveryDepth() { return maxDiscoveryDepth; }
    public String getSitemap() { return sitemap; }
    public Boolean getIgnoreQueryParameters() { return ignoreQueryParameters; }
    public Boolean getDeduplicateSimilarURLs() { return deduplicateSimilarURLs; }
    public Integer getLimit() { return limit; }
    public Boolean getCrawlEntireDomain() { return crawlEntireDomain; }
    public Boolean getAllowExternalLinks() { return allowExternalLinks; }
    public Boolean getAllowSubdomains() { return allowSubdomains; }
    public Integer getDelay() { return delay; }
    public Integer getMaxConcurrency() { return maxConcurrency; }
    public Object getWebhook() { return webhook; }
    public ScrapeOptions getScrapeOptions() { return scrapeOptions; }
    public Boolean getRegexOnFullURL() { return regexOnFullURL; }
    public Boolean getZeroDataRetention() { return zeroDataRetention; }
    public String getIntegration() { return integration; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String prompt;
        private List<String> excludePaths;
        private List<String> includePaths;
        private Integer maxDiscoveryDepth;
        private String sitemap;
        private Boolean ignoreQueryParameters;
        private Boolean deduplicateSimilarURLs;
        private Integer limit;
        private Boolean crawlEntireDomain;
        private Boolean allowExternalLinks;
        private Boolean allowSubdomains;
        private Integer delay;
        private Integer maxConcurrency;
        private Object webhook;
        private ScrapeOptions scrapeOptions;
        private Boolean regexOnFullURL;
        private Boolean zeroDataRetention;
        private String integration;

        private Builder() {}

        /** Natural language prompt to guide crawling. */
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }

        /** URL path patterns to exclude from crawling. */
        public Builder excludePaths(List<String> excludePaths) { this.excludePaths = excludePaths; return this; }

        /** URL path patterns to include in crawling. */
        public Builder includePaths(List<String> includePaths) { this.includePaths = includePaths; return this; }

        /** Maximum depth to discover links. */
        public Builder maxDiscoveryDepth(Integer maxDiscoveryDepth) { this.maxDiscoveryDepth = maxDiscoveryDepth; return this; }

        /** Sitemap handling: "skip", "include", or "only". */
        public Builder sitemap(String sitemap) { this.sitemap = sitemap; return this; }

        /** Ignore query parameters when deduplicating URLs. */
        public Builder ignoreQueryParameters(Boolean ignoreQueryParameters) { this.ignoreQueryParameters = ignoreQueryParameters; return this; }

        /** Deduplicate URLs that are similar. */
        public Builder deduplicateSimilarURLs(Boolean deduplicateSimilarURLs) { this.deduplicateSimilarURLs = deduplicateSimilarURLs; return this; }

        /** Maximum number of pages to crawl. */
        public Builder limit(Integer limit) { this.limit = limit; return this; }

        /** Whether to crawl the entire domain. */
        public Builder crawlEntireDomain(Boolean crawlEntireDomain) { this.crawlEntireDomain = crawlEntireDomain; return this; }

        /** Follow external links. */
        public Builder allowExternalLinks(Boolean allowExternalLinks) { this.allowExternalLinks = allowExternalLinks; return this; }

        /** Follow subdomains. */
        public Builder allowSubdomains(Boolean allowSubdomains) { this.allowSubdomains = allowSubdomains; return this; }

        /** Delay in milliseconds between requests. */
        public Builder delay(Integer delay) { this.delay = delay; return this; }

        /** Maximum concurrent requests. */
        public Builder maxConcurrency(Integer maxConcurrency) { this.maxConcurrency = maxConcurrency; return this; }

        /** Webhook URL string or {@link WebhookConfig} object. */
        public Builder webhook(Object webhook) { this.webhook = webhook; return this; }

        /** Scrape options applied to each crawled page. */
        public Builder scrapeOptions(ScrapeOptions scrapeOptions) { this.scrapeOptions = scrapeOptions; return this; }

        /** Apply regex patterns to the full URL, not just the path. */
        public Builder regexOnFullURL(Boolean regexOnFullURL) { this.regexOnFullURL = regexOnFullURL; return this; }

        /** Do not store any scraped data on Firecrawl servers. */
        public Builder zeroDataRetention(Boolean zeroDataRetention) { this.zeroDataRetention = zeroDataRetention; return this; }

        /** Integration identifier. */
        public Builder integration(String integration) { this.integration = integration; return this; }

        public CrawlOptions build() {
            CrawlOptions o = new CrawlOptions();
            o.prompt = this.prompt;
            o.excludePaths = this.excludePaths;
            o.includePaths = this.includePaths;
            o.maxDiscoveryDepth = this.maxDiscoveryDepth;
            o.sitemap = this.sitemap;
            o.ignoreQueryParameters = this.ignoreQueryParameters;
            o.deduplicateSimilarURLs = this.deduplicateSimilarURLs;
            o.limit = this.limit;
            o.crawlEntireDomain = this.crawlEntireDomain;
            o.allowExternalLinks = this.allowExternalLinks;
            o.allowSubdomains = this.allowSubdomains;
            o.delay = this.delay;
            o.maxConcurrency = this.maxConcurrency;
            o.webhook = this.webhook;
            o.scrapeOptions = this.scrapeOptions;
            o.regexOnFullURL = this.regexOnFullURL;
            o.zeroDataRetention = this.zeroDataRetention;
            o.integration = this.integration;
            return o;
        }
    }
}
