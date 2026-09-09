package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Identity of the agent that produced a trace event.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceAgentIdentity {

    private String id;
    private String role;
    private String name;
    private String parentId;

    public String getId() { return id; }
    public String getRole() { return role; }
    public String getName() { return name; }
    public String getParentId() { return parentId; }

    @Override
    public String toString() {
        return "AgentTraceAgentIdentity{id=" + id + ", role=" + role + ", name=" + name + "}";
    }
}
