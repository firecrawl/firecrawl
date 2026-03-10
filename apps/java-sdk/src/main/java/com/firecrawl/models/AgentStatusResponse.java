package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Status response for an agent task.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentStatusResponse {

    private boolean success;
    private String status;
    private String error;
    private Object data;
    private String model;
    private String expiresAt;
    private Integer creditsUsed;

    public boolean isSuccess() { return success; }
    public String getStatus() { return status; }
    public String getError() { return error; }
    public Object getData() { return data; }
    public String getModel() { return model; }
    public String getExpiresAt() { return expiresAt; }
    public Integer getCreditsUsed() { return creditsUsed; }

    public boolean isDone() {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status);
    }

    @Override
    public String toString() {
        return "AgentStatusResponse{status=" + status + ", model=" + model + "}";
    }
}
