package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A single agent run as returned by the agent list endpoint.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentListItem {

    private String id;
    private String createdAt;
    private String targetHint;
    private String origin;
    private String integration;
    private AgentListItemSettings settings;
    private String status;
    private AgentListItemOptions options;

    public String getId() { return id; }
    public String getCreatedAt() { return createdAt; }
    public String getTargetHint() { return targetHint; }
    public String getOrigin() { return origin; }
    public String getIntegration() { return integration; }
    public AgentListItemSettings getSettings() { return settings; }
    public String getStatus() { return status; }
    public AgentListItemOptions getOptions() { return options; }

    @Override
    public String toString() {
        return "AgentListItem{id=" + id + ", status=" + status + "}";
    }
}
