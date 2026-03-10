package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from creating a new browser session.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BrowserCreateResponse {

    private boolean success;
    private String id;
    private String cdpUrl;
    private String liveViewUrl;
    private String expiresAt;
    private String error;

    public boolean isSuccess() { return success; }
    public String getId() { return id; }
    public String getCdpUrl() { return cdpUrl; }
    public String getLiveViewUrl() { return liveViewUrl; }
    public String getExpiresAt() { return expiresAt; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "BrowserCreateResponse{id=" + id + ", success=" + success + "}";
    }
}
