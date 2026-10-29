package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Per-field diff entry returned for monitors that requested JSON
 * extraction. The keys on {@link MonitorPageDiff#getJson()} (when used in
 * JSON or mixed mode) are field paths in the extracted JSON; the values
 * are instances of this class describing what changed between the
 * previous and current run.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorJsonFieldDiff {
    private Object previous;
    private Object current;

    public Object getPrevious() { return previous; }
    public Object getCurrent() { return current; }
}
