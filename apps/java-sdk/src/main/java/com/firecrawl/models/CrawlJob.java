package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Status and results of a crawl job.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class CrawlJob {

    private String id;
    private String status;
    private int total;
    private int completed;
    private Integer creditsUsed;
    private String expiresAt;
    private String next;
    private List<Document> data;

    public String getId() { return id; }
    public String getStatus() { return status; }
    public int getTotal() { return total; }
    public int getCompleted() { return completed; }
    public Integer getCreditsUsed() { return creditsUsed; }
    public String getExpiresAt() { return expiresAt; }
    public String getNext() { return next; }
    public List<Document> getData() { return data; }
    public void setData(List<Document> data) { this.data = data; }

    /** Returns true if the job has finished (completed, failed, or cancelled). */
    public boolean isDone() {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status);
    }

    @Override
    public String toString() {
        return "CrawlJob{id=" + id + ", status=" + status + ", completed=" + completed + "/" + total + "}";
    }
}
