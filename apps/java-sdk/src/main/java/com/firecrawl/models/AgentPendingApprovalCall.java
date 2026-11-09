package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

/**
 * A paid provider call held back by a pending approval.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentPendingApprovalCall {

    private String id;
    private String provider;
    private String capability;
    private Map<String, Object> input;
    private List<Map<String, Object>> more;
    private Integer creditsEstimate;

    public String getId() { return id; }
    public String getProvider() { return provider; }
    public String getCapability() { return capability; }
    public Map<String, Object> getInput() { return input; }
    public List<Map<String, Object>> getMore() { return more; }
    /** Null when the provider lists no per-call price. */
    public Integer getCreditsEstimate() { return creditsEstimate; }

    @Override
    public String toString() {
        return "AgentPendingApprovalCall{id=" + id + ", provider=" + provider + ", capability=" + capability + "}";
    }
}
