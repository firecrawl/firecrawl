package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from deleting a browser session.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BrowserDeleteResponse {

    private boolean success;
    private Long sessionDurationMs;
    private Integer creditsBilled;
    private String error;

    public boolean isSuccess() { return success; }
    public Long getSessionDurationMs() { return sessionDurationMs; }
    public Integer getCreditsBilled() { return creditsBilled; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "BrowserDeleteResponse{success=" + success + ", creditsBilled=" + creditsBilled + "}";
    }
}
