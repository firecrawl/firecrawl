package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Response from the agent trace endpoint.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceResponse {

    private boolean success;
    private String id;
    private List<AgentTraceEvent> events;
    private Integer creditsUsed;
    private List<AgentTraceActiveBrowserSession> activeBrowserSessions;
    private String error;

    public boolean isSuccess() { return success; }
    public String getId() { return id; }
    public List<AgentTraceEvent> getEvents() { return events; }
    public Integer getCreditsUsed() { return creditsUsed; }
    public List<AgentTraceActiveBrowserSession> getActiveBrowserSessions() { return activeBrowserSessions; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "AgentTraceResponse{success=" + success + ", id=" + id + ", events="
                + (events != null ? events.size() : 0) + "}";
    }
}
