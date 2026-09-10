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
}
