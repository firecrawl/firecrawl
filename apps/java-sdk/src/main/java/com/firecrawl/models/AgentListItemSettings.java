package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Per-session settings attached to an agent run.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentListItemSettings {

    private boolean hidden;
    private boolean starred;
    private String label;

    public boolean isHidden() { return hidden; }
    public boolean isStarred() { return starred; }
    public String getLabel() { return label; }

    @Override
    public String toString() {
        return "AgentListItemSettings{hidden=" + hidden + ", starred=" + starred + "}";
    }
}
