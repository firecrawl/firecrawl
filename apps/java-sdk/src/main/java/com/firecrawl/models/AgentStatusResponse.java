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
    private String effort;
    private String expiresAt;
    private Integer creditsUsed;
    private String threadId;
    private Integer threadTurn;
    private String mode;
    private String message;
    private AgentPendingApproval pendingApproval;
    private AgentExchangeSummary exchange;

    public boolean isSuccess() { return success; }
    public String getStatus() { return status; }
    public String getError() { return error; }
    public Object getData() { return data; }
    public String getModel() { return model; }
    /** The effort the job ran with; only present for runs that specified it. */
    public String getEffort() { return effort; }
    public String getExpiresAt() { return expiresAt; }
    public Integer getCreditsUsed() { return creditsUsed; }
    public String getThreadId() { return threadId; }
    public Integer getThreadTurn() { return threadTurn; }
    public String getMode() { return mode; }
    /** Text reply. Chat-mode runs answer here instead of in {@code data}. */
    public String getMessage() { return message; }
    /** Set when the turn ended waiting for the caller to approve or decline. */
    public AgentPendingApproval getPendingApproval() { return pendingApproval; }
    public AgentExchangeSummary getExchange() { return exchange; }

    public boolean isDone() {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status);
    }

    @Override
    public String toString() {
        return "AgentStatusResponse{status=" + status + ", model=" + model + "}";
    }
}
