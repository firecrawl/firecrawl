package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from the agent snapshot endpoint.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentSnapshotResponse {

    private boolean success;
    private String id;
    private String snapshotId;
    private String snapshot;
    private String error;

    public boolean isSuccess() { return success; }
    public String getId() { return id; }
    public String getSnapshotId() { return snapshotId; }
    public String getSnapshot() { return snapshot; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "AgentSnapshotResponse{success=" + success + ", id=" + id + ", snapshotId=" + snapshotId + "}";
    }
}
