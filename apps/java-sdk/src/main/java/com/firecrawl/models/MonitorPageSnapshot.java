package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.Map;

/**
 * Snapshot of the current JSON extraction at this run. Present on JSON
 * and mixed-mode monitors; absent for markdown-only monitors.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorPageSnapshot {
    private Map<String, Object> json;

    public Map<String, Object> getJson() { return json; }
}
