<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentStatusResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $status = null,
        private readonly ?string $error = null,
        private readonly mixed $data = null,
        private readonly ?string $model = null,
        private readonly ?string $effort = null,
        private readonly ?string $expiresAt = null,
        private readonly ?int $creditsUsed = null,
        private readonly ?string $threadId = null,
        private readonly ?int $threadTurn = null,
        private readonly ?string $mode = null,
        private readonly ?string $message = null,
        private readonly ?AgentPendingApproval $pendingApproval = null,
        private readonly ?AgentExchangeSummary $exchange = null,
    ) {}

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        return new self(
            success: (bool) ($raw['success'] ?? false),
            status: $raw['status'] ?? null,
            error: $raw['error'] ?? null,
            data: $raw['data'] ?? null,
            model: $raw['model'] ?? null,
            effort: $raw['effort'] ?? null,
            expiresAt: $raw['expiresAt'] ?? null,
            creditsUsed: isset($raw['creditsUsed']) ? (int) $raw['creditsUsed'] : null,
            threadId: $raw['threadId'] ?? null,
            threadTurn: isset($raw['threadTurn']) ? (int) $raw['threadTurn'] : null,
            mode: $raw['mode'] ?? null,
            message: $raw['message'] ?? null,
            pendingApproval: isset($raw['pendingApproval']) && is_array($raw['pendingApproval'])
                ? AgentPendingApproval::fromArray($raw['pendingApproval'])
                : null,
            exchange: isset($raw['exchange']) && is_array($raw['exchange'])
                ? AgentExchangeSummary::fromArray($raw['exchange'])
                : null,
        );
    }

    public function isDone(): bool
    {
        return in_array($this->status, ['completed', 'failed', 'cancelled'], true);
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    public function getStatus(): ?string
    {
        return $this->status;
    }

    public function getError(): ?string
    {
        return $this->error;
    }

    public function getData(): mixed
    {
        return $this->data;
    }

    public function getModel(): ?string
    {
        return $this->model;
    }

    /**
     * The effort ("low", "medium", or "high") the job ran with. Only present
     * for runs that specified one.
     */
    public function getEffort(): ?string
    {
        return $this->effort;
    }

    public function getExpiresAt(): ?string
    {
        return $this->expiresAt;
    }

    public function getCreditsUsed(): ?int
    {
        return $this->creditsUsed;
    }

    public function getThreadId(): ?string
    {
        return $this->threadId;
    }

    public function getThreadTurn(): ?int
    {
        return $this->threadTurn;
    }

    /** "extract" or "chat". */
    public function getMode(): ?string
    {
        return $this->mode;
    }

    /** The text reply of a chat-mode run, which answers here instead of in data. */
    public function getMessage(): ?string
    {
        return $this->message;
    }

    /** Set when the turn ended waiting for the caller to approve or decline. */
    public function getPendingApproval(): ?AgentPendingApproval
    {
        return $this->pendingApproval;
    }

    /** What the run did with Exchange. */
    public function getExchange(): ?AgentExchangeSummary
    {
        return $this->exchange;
    }
}
