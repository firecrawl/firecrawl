package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Response from listing browser sessions.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BrowserListResponse {

    private boolean success;
    private List<BrowserSession> sessions;
    private String error;

    public boolean isSuccess() { return success; }
    public List<BrowserSession> getSessions() { return sessions; }
    public String getError() { return error; }

    @Override
    public String toString() {
        int count = sessions != null ? sessions.size() : 0;
        return "BrowserListResponse{success=" + success + ", sessions=" + count + "}";
    }
}
