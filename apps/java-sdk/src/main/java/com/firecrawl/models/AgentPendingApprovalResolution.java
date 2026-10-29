package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * How a later turn answered a pending approval.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentPendingApprovalResolution {

    private boolean approved;
    private List<String> callIds;
    private boolean always;
    private String byRunId;

    public boolean isApproved() { return approved; }
    /** Calls approved. Empty on a terms approval. */
    public List<String> getCallIds() { return callIds; }
    public boolean isAlways() { return always; }
    public String getByRunId() { return byRunId; }

    @Override
    public String toString() {
        return "AgentPendingApprovalResolution{approved=" + approved + ", byRunId=" + byRunId + "}";
    }
}
