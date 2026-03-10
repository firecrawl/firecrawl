package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from starting an async crawl job.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class CrawlResponse {

    private String id;
    private String url;

    public String getId() { return id; }
    public String getUrl() { return url; }

    @Override
    public String toString() {
        return "CrawlResponse{id=" + id + ", url=" + url + "}";
    }
}
