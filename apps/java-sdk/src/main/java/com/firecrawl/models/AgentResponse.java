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
    private String threadId;
    private Integer threadTurn;

    public boolean isSuccess() { return success; }
    public String getId() { return id; }
    public String getError() { return error; }
    /** Thread this run belongs to; pass it to {@code AgentOptions.Builder.threadId} to continue it. */
    public String getThreadId() { return threadId; }
    /** 1-based position of this run in its thread. */
    public Integer getThreadTurn() { return threadTurn; }

    @Override
    public String toString() {
        return "AgentResponse{success=" + success + ", id=" + id + "}";
    }
}
