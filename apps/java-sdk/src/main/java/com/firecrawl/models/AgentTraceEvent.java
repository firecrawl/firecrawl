package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * A single event in an agent run trace.
 *
 * <p>Models all event kinds in one class; per-type fields are null when not
 * applicable. Known {@code type} values: {@code run.started},
 * {@code run.cancel_requested}, {@code run.finished}, {@code agent.started},
 * {@code agent.finished}, {@code browser.session.started},
 * {@code browser.session.finished}, {@code progress.reported},
 * {@code reasoning.summary}, {@code tool_call.started},
 * {@code tool_call.finished}, {@code artifact.updated}, {@code error.occurred}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceEvent {

    private String type;

    // Base fields present on every event
    private int schemaVersion;
    private String eventId;
    private String runId;
    private String occurredAt;
    private long producerSequence;
    private AgentTraceAgentIdentity agent;

    // Per-type fields (nullable)
    private String reason;
    private String outcome;
    private AgentTraceError error;
    private Long durationMs;
    private String sessionId;
    private String phase;
    private String message;
    private String text;
    private String toolCallId;
    private String toolName;
    private Object parameters;
    private Object result;
    private AgentTraceArtifactChange artifact;

    public String getType() { return type; }
    public int getSchemaVersion() { return schemaVersion; }
    public String getEventId() { return eventId; }
    public String getRunId() { return runId; }
    public String getOccurredAt() { return occurredAt; }
    public long getProducerSequence() { return producerSequence; }
    public AgentTraceAgentIdentity getAgent() { return agent; }
    public String getReason() { return reason; }
    public String getOutcome() { return outcome; }
    public AgentTraceError getError() { return error; }
    public Long getDurationMs() { return durationMs; }
    public String getSessionId() { return sessionId; }
    public String getPhase() { return phase; }
    public String getMessage() { return message; }
    public String getText() { return text; }
    public String getToolCallId() { return toolCallId; }
    public String getToolName() { return toolName; }
    public Object getParameters() { return parameters; }
    public Object getResult() { return result; }
    public AgentTraceArtifactChange getArtifact() { return artifact; }

    @Override
    public String toString() {
        return "AgentTraceEvent{type=" + type + ", eventId=" + eventId + ", occurredAt=" + occurredAt + "}";
    }
}
