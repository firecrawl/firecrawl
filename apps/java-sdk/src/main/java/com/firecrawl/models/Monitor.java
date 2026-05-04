package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

@JsonIgnoreProperties(ignoreUnknown = true)
public class Monitor {
    private String id;
    private String name;
    private String status;
    private MonitorSchedule schedule;
    private String nextRunAt;
    private String lastRunAt;
    private String currentCheckId;
    private List<Map<String, Object>> targets;
    private Map<String, Object> webhook;
    private Map<String, Object> notification;
    private int retentionDays;
    private Integer estimatedCreditsPerMonth;
    private MonitorSummary lastCheckSummary;
    private String createdAt;
    private String updatedAt;

    public String getId() { return id; }
    public String getName() { return name; }
    public String getStatus() { return status; }
    public MonitorSchedule getSchedule() { return schedule; }
    public String getNextRunAt() { return nextRunAt; }
    public String getLastRunAt() { return lastRunAt; }
    public String getCurrentCheckId() { return currentCheckId; }
    public List<Map<String, Object>> getTargets() { return targets; }
    public Map<String, Object> getWebhook() { return webhook; }
    public Map<String, Object> getNotification() { return notification; }
    public int getRetentionDays() { return retentionDays; }
    public Integer getEstimatedCreditsPerMonth() { return estimatedCreditsPerMonth; }
    public MonitorSummary getLastCheckSummary() { return lastCheckSummary; }
    public String getCreatedAt() { return createdAt; }
    public String getUpdatedAt() { return updatedAt; }
}
