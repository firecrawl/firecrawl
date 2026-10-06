package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.Map;

/**
 * A provider whose terms the caller can view and accept.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTermsActionProvider {

    private String provider;
    private String name;
    private String capability;
    private String adds;
    private String version;
    private String digest;
    private String url;
    private Map<String, Object> show;
    private Map<String, Object> accept;

    public String getProvider() { return provider; }
    public String getName() { return name; }
    public String getCapability() { return capability; }
    public String getAdds() { return adds; }
    public String getVersion() { return version; }
    /** Null when the catalog published no digest; terms/show returns it. */
    public String getDigest() { return digest; }
    public String getUrl() { return url; }
    /** The Exchange call that shows the terms: provider, capability, options. */
    public Map<String, Object> getShow() { return show; }
    /** The Exchange call that accepts the terms: provider, capability, options. */
    public Map<String, Object> getAccept() { return accept; }

    @Override
    public String toString() {
        return "AgentTermsActionProvider{provider=" + provider + ", version=" + version + "}";
    }
}
