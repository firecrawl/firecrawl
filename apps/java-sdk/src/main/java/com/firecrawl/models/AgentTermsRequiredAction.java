package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * The Exchange calls to view and accept providers' terms. Nothing here runs for
 * you; only call terms/accept after the user has explicitly agreed.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTermsRequiredAction {

    private String type;
    private String approvalId;
    private List<AgentTermsActionProvider> providers;

    /** "accept_terms". */
    public String getType() { return type; }
    /** The terms pending approval to answer with {@code AgentExchangeOptions.Approve} once the terms are accepted. */
    public String getApprovalId() { return approvalId; }
    public List<AgentTermsActionProvider> getProviders() { return providers; }

    @Override
    public String toString() {
        return "AgentTermsRequiredAction{type=" + type + ", approvalId=" + approvalId + "}";
    }
}
