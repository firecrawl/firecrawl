<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BrowserDeleteResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?int $sessionDurationMs = null,
        private readonly ?int $creditsBilled = null,
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            success: (bool) ($data['success'] ?? false),
            sessionDurationMs: isset($data['sessionDurationMs']) ? (int) $data['sessionDurationMs'] : null,
            creditsBilled: isset($data['creditsBilled']) ? (int) $data['creditsBilled'] : null,
            error: $data['error'] ?? null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    public function getSessionDurationMs(): ?int
    {
        return $this->sessionDurationMs;
    }

    public function getCreditsBilled(): ?int
    {
        return $this->creditsBilled;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
