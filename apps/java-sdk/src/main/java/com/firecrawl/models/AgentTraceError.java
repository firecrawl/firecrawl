package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Structured error carried by agent trace events.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceError {

    private String code;
    private String source;
    private boolean retryable;
    private String message;

    public String getCode() { return code; }
    public String getSource() { return source; }
    public boolean isRetryable() { return retryable; }
    public String getMessage() { return message; }

    @Override
    public String toString() {
        return "AgentTraceError{code=" + code + ", source=" + source + ", retryable=" + retryable + "}";
    }
}
