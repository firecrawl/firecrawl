package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * An active browser session attached to an agent run, with a live view URL.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceActiveBrowserSession {

    private String id;
    private String liveViewUrl;
    private AgentTraceViewport viewport;

    public String getId() { return id; }
    public String getLiveViewUrl() { return liveViewUrl; }
    public AgentTraceViewport getViewport() { return viewport; }

    @Override
    public String toString() {
        return "AgentTraceActiveBrowserSession{id=" + id + "}";
    }
}
