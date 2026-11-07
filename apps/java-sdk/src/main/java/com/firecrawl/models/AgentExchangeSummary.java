package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * What an agent run did with Exchange (Alexandria data providers).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentExchangeSummary {

    private boolean enabled;
    private List<String> toolkits;
    private Boolean requireApproval;
    private String onTermsRequired;
    private int paidCalls;
    private Integer creditsUsed;
    private List<AgentSkippedProvider> skippedProviders;
    private AgentTermsRequiredAction requiresAction;

    public boolean isEnabled() { return enabled; }
    /** What the run resolved to after thread inheritance, not what it requested. */
    public List<String> getToolkits() { return toolkits; }
    public Boolean getRequireApproval() { return requireApproval; }
    public String getOnTermsRequired() { return onTermsRequired; }
    public int getPaidCalls() { return paidCalls; }
    public Integer getCreditsUsed() { return creditsUsed; }
    /** Providers that need terms the team has not accepted, so the run did not use them. */
    public List<AgentSkippedProvider> getSkippedProviders() { return skippedProviders; }
    /** Set in "ask" mode when a terms offer ended the turn. */
    public AgentTermsRequiredAction getRequiresAction() { return requiresAction; }

    @Override
    public String toString() {
        return "AgentExchangeSummary{enabled=" + enabled + ", paidCalls=" + paidCalls + ", creditsUsed=" + creditsUsed + "}";
    }
}
