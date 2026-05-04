package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorCheck {
    private String id;
    private String monitorId;
    private String status;
    private String trigger;
    private String scheduledFor;
    private String startedAt;
    private String finishedAt;
    private Integer estimatedCredits;
    private Integer reservedCredits;
    private Integer actualCredits;
    private String billingStatus;
    private MonitorSummary summary;
    private Object targetResults;
    private Object notificationStatus;
    private String error;
    private String createdAt;
    private String updatedAt;

    public String getId() { return id; }
    public String getMonitorId() { return monitorId; }
    public String getStatus() { return status; }
    public String getTrigger() { return trigger; }
    public String getScheduledFor() { return scheduledFor; }
    public String getStartedAt() { return startedAt; }
    public String getFinishedAt() { return finishedAt; }
    public Integer getEstimatedCredits() { return estimatedCredits; }
    public Integer getReservedCredits() { return reservedCredits; }
    public Integer getActualCredits() { return actualCredits; }
    public String getBillingStatus() { return billingStatus; }
    public MonitorSummary getSummary() { return summary; }
    public Object getTargetResults() { return targetResults; }
    public Object getNotificationStatus() { return notificationStatus; }
    public String getError() { return error; }
    public String getCreatedAt() { return createdAt; }
    public String getUpdatedAt() { return updatedAt; }
}
