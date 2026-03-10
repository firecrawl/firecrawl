package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Response from starting an async batch scrape job.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BatchScrapeResponse {

    private String id;
    private String url;
    private List<String> invalidURLs;

    public String getId() { return id; }
    public String getUrl() { return url; }
    public List<String> getInvalidURLs() { return invalidURLs; }

    @Override
    public String toString() {
        return "BatchScrapeResponse{id=" + id + ", url=" + url + "}";
    }
}
