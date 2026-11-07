package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Options an agent run was started with.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentListItemOptions {

    private List<String> urls;
    private String prompt;
    private Object schema;
    private String model;
    private String effort;

    public List<String> getUrls() { return urls; }
    public String getPrompt() { return prompt; }
    public Object getSchema() { return schema; }
    public String getModel() { return model; }
    /** The effort the run used; only present for runs that specified one. */
    public String getEffort() { return effort; }

    @Override
    public String toString() {
        return "AgentListItemOptions{prompt=" + prompt + ", model=" + model + "}";
    }
}
