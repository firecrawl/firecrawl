<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * A single agent trace event. One model covers every event `type`
 * (run.started, tool_call.finished, artifact.updated, ...); fields that do
 * not apply to a given type stay null.
 */
final class AgentTraceEvent
{
    public function __construct(
        private readonly ?string $type = null,
        private readonly ?int $schemaVersion = null,
        private readonly ?string $eventId = null,
        private readonly ?string $runId = null,
        private readonly ?string $occurredAt = null,
        private readonly ?int $producerSequence = null,
        private readonly ?AgentTraceAgentIdentity $agent = null,
        private readonly ?string $reason = null,
        private readonly ?string $outcome = null,
        private readonly ?AgentTraceError $error = null,
        private readonly ?int $durationMs = null,
        private readonly ?string $sessionId = null,
        private readonly ?string $phase = null,
        private readonly ?string $message = null,
        private readonly ?string $text = null,
        private readonly ?string $toolCallId = null,
        private readonly ?string $toolName = null,
        private readonly mixed $parameters = null,
        private readonly mixed $result = null,
        private readonly ?AgentTraceArtifactChange $artifact = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            type: $data['type'] ?? null,
            schemaVersion: isset($data['schemaVersion']) ? (int) $data['schemaVersion'] : null,
            eventId: $data['eventId'] ?? null,
            runId: $data['runId'] ?? null,
            occurredAt: $data['occurredAt'] ?? null,
            producerSequence: isset($data['producerSequence']) ? (int) $data['producerSequence'] : null,
            agent: isset($data['agent']) && is_array($data['agent'])
                ? AgentTraceAgentIdentity::fromArray($data['agent'])
                : null,
            reason: $data['reason'] ?? null,
            outcome: $data['outcome'] ?? null,
            error: isset($data['error']) && is_array($data['error'])
                ? AgentTraceError::fromArray($data['error'])
                : null,
            durationMs: isset($data['durationMs']) ? (int) $data['durationMs'] : null,
            sessionId: $data['sessionId'] ?? null,
            phase: $data['phase'] ?? null,
            message: $data['message'] ?? null,
            text: $data['text'] ?? null,
            toolCallId: $data['toolCallId'] ?? null,
            toolName: $data['toolName'] ?? null,
            parameters: $data['parameters'] ?? null,
            result: $data['result'] ?? null,
            artifact: isset($data['artifact']) && is_array($data['artifact'])
                ? AgentTraceArtifactChange::fromArray($data['artifact'])
                : null,
        );
    }

    public function getType(): ?string
    {
        return $this->type;
    }

    public function getSchemaVersion(): ?int
    {
        return $this->schemaVersion;
    }

    public function getEventId(): ?string
    {
        return $this->eventId;
    }

    public function getRunId(): ?string
    {
        return $this->runId;
    }

    public function getOccurredAt(): ?string
    {
        return $this->occurredAt;
    }

    public function getProducerSequence(): ?int
    {
        return $this->producerSequence;
    }

    public function getAgent(): ?AgentTraceAgentIdentity
    {
        return $this->agent;
    }

    public function getReason(): ?string
    {
        return $this->reason;
    }

    public function getOutcome(): ?string
    {
        return $this->outcome;
    }

    public function getError(): ?AgentTraceError
    {
        return $this->error;
    }

    public function getDurationMs(): ?int
    {
        return $this->durationMs;
    }

    public function getSessionId(): ?string
    {
        return $this->sessionId;
    }

    public function getPhase(): ?string
    {
        return $this->phase;
    }

    public function getMessage(): ?string
    {
        return $this->message;
    }

    public function getText(): ?string
    {
        return $this->text;
    }

    public function getToolCallId(): ?string
    {
        return $this->toolCallId;
    }

    public function getToolName(): ?string
    {
        return $this->toolName;
    }

    public function getParameters(): mixed
    {
        return $this->parameters;
    }

    public function getResult(): mixed
    {
        return $this->result;
    }

    public function getArtifact(): ?AgentTraceArtifactChange
    {
        return $this->artifact;
    }
}
