package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A provider the run would have used but skipped because its terms are not accepted.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentSkippedProvider {

    private String provider;
    private String name;
    private String capability;
    private String adds;
    private String reason;
    private String version;
    private String termsUrl;

    public String getProvider() { return provider; }
    public String getName() { return name; }
    public String getCapability() { return capability; }
    /** What it would have added, in the agent's words. */
    public String getAdds() { return adds; }
    /** "terms_required". */
    public String getReason() { return reason; }
    public String getVersion() { return version; }
    /** Where a person accepts the terms in the dashboard. */
    public String getTermsUrl() { return termsUrl; }

    @Override
    public String toString() {
        return "AgentSkippedProvider{provider=" + provider + ", reason=" + reason + "}";
    }
}
