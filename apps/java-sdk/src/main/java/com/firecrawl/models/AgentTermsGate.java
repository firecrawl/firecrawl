package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A provider in a "terms" pending approval.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTermsGate {

    private String provider;
    private String name;
    private String logo;
    private String capability;
    private String adds;
    private String version;
    private String digest;
    private String url;

    public String getProvider() { return provider; }
    public String getName() { return name; }
    public String getLogo() { return logo; }
    public String getCapability() { return capability; }
    public String getAdds() { return adds; }
    public String getVersion() { return version; }
    /** Null when the catalog published no digest; terms/show returns it. */
    public String getDigest() { return digest; }
    /** Where a person accepts the terms in the dashboard. */
    public String getUrl() { return url; }

    @Override
    public String toString() {
        return "AgentTermsGate{provider=" + provider + ", version=" + version + "}";
    }
}
