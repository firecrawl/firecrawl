package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Judge's verdict on whether a monitor page change is meaningful.
 * Populated on monitor check pages when the monitor has a {@code goal}
 * set and judging is enabled.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorPageJudgment {
    private boolean meaningful;
    private String confidence;
    private String reason;
    private List<String> fields;

    public boolean isMeaningful() { return meaningful; }
    /** One of {@code high}, {@code medium}, {@code low}. */
    public String getConfidence() { return confidence; }
    public String getReason() { return reason; }
    public List<String> getFields() { return fields; }
}
