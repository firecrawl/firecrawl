<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** Declines the previous turn's pending approval. Only meaningful with a thread ID. */
final class AgentExchangeDecline
{
    private function __construct(
        private readonly string $approvalId,
    ) {}

    public static function with(string $approvalId): self
    {
        return new self($approvalId);
    }

    /** @return array{approvalId: string} */
    public function toArray(): array
    {
        return ['approvalId' => $this->approvalId];
    }
}
