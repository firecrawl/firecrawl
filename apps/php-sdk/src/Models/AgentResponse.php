<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $id = null,
        private readonly ?string $error = null,
        private readonly ?string $threadId = null,
        private readonly ?int $threadTurn = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            success: (bool) ($data['success'] ?? false),
            id: $data['id'] ?? null,
            error: $data['error'] ?? null,
            threadId: $data['threadId'] ?? null,
            threadTurn: isset($data['threadTurn']) ? (int) $data['threadTurn'] : null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getError(): ?string
    {
        return $this->error;
    }

    /** The thread this run belongs to. Pass it back as threadId to continue it. */
    public function getThreadId(): ?string
    {
        return $this->threadId;
    }

    /** 1-based position of this run in its thread. */
    public function getThreadTurn(): ?int
    {
        return $this->threadTurn;
    }
}
