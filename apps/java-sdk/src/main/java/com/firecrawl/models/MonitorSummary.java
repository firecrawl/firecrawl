package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorSummary {
    private int totalPages;
    private int same;
    private int changed;
    private int newCount;
    private int removed;
    private int error;

    public int getTotalPages() { return totalPages; }
    public int getSame() { return same; }
    public int getChanged() { return changed; }
    public int getNew() { return newCount; }
    public int getRemoved() { return removed; }
    public int getError() { return error; }

    @com.fasterxml.jackson.annotation.JsonProperty("new")
    private void setNewCount(int value) {
        this.newCount = value;
    }
}
