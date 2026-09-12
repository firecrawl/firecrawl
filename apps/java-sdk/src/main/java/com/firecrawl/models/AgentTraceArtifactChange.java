package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Describes a change to an artifact in an agent trace event.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceArtifactChange {

    private String kind;
    private String artifactId;
    private String path;
    private String snapshotId;
    private String change;
    private List<String> changedFields;
    private Integer itemCount;
    private String sourceToolCallId;

    public String getKind() { return kind; }
    public String getArtifactId() { return artifactId; }
    public String getPath() { return path; }
    public String getSnapshotId() { return snapshotId; }
    public String getChange() { return change; }
    public List<String> getChangedFields() { return changedFields; }
    public Integer getItemCount() { return itemCount; }
    public String getSourceToolCallId() { return sourceToolCallId; }

    @Override
    public String toString() {
        return "AgentTraceArtifactChange{kind=" + kind + ", artifactId=" + artifactId + ", change=" + change + "}";
    }
}
