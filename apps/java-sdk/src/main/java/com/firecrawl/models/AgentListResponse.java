package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Response from listing agent runs.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentListResponse {

    private boolean success;
    private List<AgentListItem> agents;
    /** Absolute URL of the next page; only present when more pages exist. */
    private String next;
    private String error;

    public boolean isSuccess() { return success; }
    public List<AgentListItem> getAgents() { return agents; }
    public String getNext() { return next; }
    public String getError() { return error; }

    @Override
    public String toString() {
        int count = agents != null ? agents.size() : 0;
        return "AgentListResponse{success=" + success + ", agents=" + count + "}";
    }
}
