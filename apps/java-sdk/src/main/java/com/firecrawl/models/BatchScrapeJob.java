package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Status and results of a batch scrape job.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BatchScrapeJob {

    private String id;
    private String status;
    private int completed;
    private int total;
    private Integer creditsUsed;
    private String expiresAt;
    private String next;
    private List<Document> data;

    public String getId() { return id; }
    public String getStatus() { return status; }
    public int getCompleted() { return completed; }
    public int getTotal() { return total; }
    public Integer getCreditsUsed() { return creditsUsed; }
    public String getExpiresAt() { return expiresAt; }
    public String getNext() { return next; }
    public List<Document> getData() { return data; }
    public void setData(List<Document> data) { this.data = data; }

    public boolean isDone() {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status);
    }

    @Override
    public String toString() {
        return "BatchScrapeJob{id=" + id + ", status=" + status + ", completed=" + completed + "/" + total + "}";
    }
}
