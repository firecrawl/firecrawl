<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * Approves the previous turn's pending approval. Only meaningful with a
 * thread ID. A "terms" approval is approved as a whole, so callIds and always
 * are ignored on it.
 */
final class AgentExchangeApproval
{
    /** @param list<string>|null $callIds */
    private function __construct(
        private readonly string $approvalId,
        private readonly ?array $callIds = null,
        private readonly ?bool $always = null,
    ) {}

    /** @param list<string>|null $callIds Omitted approves every pending call. */
    public static function with(string $approvalId, ?array $callIds = null, ?bool $always = null): self
    {
        return new self($approvalId, $callIds, $always);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'approvalId' => $this->approvalId,
            'callIds' => $this->callIds,
            'always' => $this->always,
        ], fn (mixed $v): bool => $v !== null);
    }
}
