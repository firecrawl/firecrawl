package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * A turn that ended waiting for the caller. Kind "calls" (or null on older runs)
 * holds paid {@code calls}; kind "terms" lists providers' {@code terms} and has no calls.
 * Answer it on the next turn of the thread with {@code AgentExchangeOptions.Approve} or
 * {@code AgentExchangeOptions.Decline}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentPendingApproval {

    private String id;
    private String kind;
    private String reason;
    private List<AgentPendingApprovalCall> calls;
    private List<AgentTermsGate> terms;
    private AgentPendingApprovalResolution resolution;

    public String getId() { return id; }
    public String getKind() { return kind; }
    public String getReason() { return reason; }
    public List<AgentPendingApprovalCall> getCalls() { return calls; }
    public List<AgentTermsGate> getTerms() { return terms; }
    /** Null until a later turn answers the approval. */
    public AgentPendingApprovalResolution getResolution() { return resolution; }

    @Override
    public String toString() {
        return "AgentPendingApproval{id=" + id + ", kind=" + kind + "}";
    }
}
