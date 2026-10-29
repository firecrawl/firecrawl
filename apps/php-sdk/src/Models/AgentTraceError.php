<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceError
{
    public function __construct(
        private readonly ?string $code = null,
        private readonly ?string $source = null,
        private readonly bool $retryable = false,
        private readonly ?string $message = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            code: $data['code'] ?? null,
            source: $data['source'] ?? null,
            retryable: (bool) ($data['retryable'] ?? false),
            message: $data['message'] ?? null,
        );
    }

    public function getCode(): ?string
    {
        return $this->code;
    }

    public function getSource(): ?string
    {
        return $this->source;
    }

    public function isRetryable(): bool
    {
        return $this->retryable;
    }

    public function getMessage(): ?string
    {
        return $this->message;
    }
}
