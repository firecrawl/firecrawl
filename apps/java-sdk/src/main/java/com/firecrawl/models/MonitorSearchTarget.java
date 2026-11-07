package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * A search monitor target ({@code type = "search"}).
 *
 * <p>Search targets run one or more queries on each monitor check and report how many
 * results matched the monitor's goal. They live in a monitor's {@code targets} list
 * alongside scrape and crawl targets.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class MonitorSearchTarget {
    private String id;
    private final String type = "search";
    private List<String> queries;
    private String searchWindow;
    private List<String> includeDomains;
    private List<String> excludeDomains;
    private Integer maxResults;

    public MonitorSearchTarget() {}

    public MonitorSearchTarget(List<String> queries) {
        this.queries = queries;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    /** Always {@code "search"}. */
    public String getType() { return type; }

    public List<String> getQueries() { return queries; }
    public void setQueries(List<String> queries) { this.queries = queries; }

    /** One of {@code 5m}, {@code 15m}, {@code 1h}, {@code 6h}, {@code 24h}, {@code 7d}. */
    public String getSearchWindow() { return searchWindow; }
    public void setSearchWindow(String searchWindow) { this.searchWindow = searchWindow; }

    public List<String> getIncludeDomains() { return includeDomains; }
    public void setIncludeDomains(List<String> includeDomains) { this.includeDomains = includeDomains; }

    public List<String> getExcludeDomains() { return excludeDomains; }
    public void setExcludeDomains(List<String> excludeDomains) { this.excludeDomains = excludeDomains; }

    public Integer getMaxResults() { return maxResults; }
    public void setMaxResults(Integer maxResults) { this.maxResults = maxResults; }
}
