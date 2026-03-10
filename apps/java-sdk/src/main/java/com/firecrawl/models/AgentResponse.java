package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from starting an agent task.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentResponse {

    private boolean success;
    private String id;
    private String error;

    public boolean isSuccess() { return success; }
    public String getId() { return id; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "AgentResponse{success=" + success + ", id=" + id + "}";
    }
}
