package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Represents a browser session's metadata.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BrowserSession {

    private String id;
    private String status;
    private String cdpUrl;
    private String liveViewUrl;
    private boolean streamWebView;
    private String createdAt;
    private String lastActivity;

    public String getId() { return id; }
    public String getStatus() { return status; }
    public String getCdpUrl() { return cdpUrl; }
    public String getLiveViewUrl() { return liveViewUrl; }
    public boolean isStreamWebView() { return streamWebView; }
    public String getCreatedAt() { return createdAt; }
    public String getLastActivity() { return lastActivity; }

    @Override
    public String toString() {
        return "BrowserSession{id=" + id + ", status=" + status + "}";
    }
}
