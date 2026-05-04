package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorCheckPage {
    private String id;
    private String targetId;
    private String url;
    private String status;
    private String previousScrapeId;
    private String currentScrapeId;
    private Integer statusCode;
    private String error;
    private Object metadata;
    private Object diff;
    private String createdAt;

    public String getId() { return id; }
    public String getTargetId() { return targetId; }
    public String getUrl() { return url; }
    public String getStatus() { return status; }
    public String getPreviousScrapeId() { return previousScrapeId; }
    public String getCurrentScrapeId() { return currentScrapeId; }
    public Integer getStatusCode() { return statusCode; }
    public String getError() { return error; }
    public Object getMetadata() { return metadata; }
    public Object getDiff() { return diff; }
    public String getCreatedAt() { return createdAt; }
}
