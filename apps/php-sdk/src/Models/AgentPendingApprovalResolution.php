<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** How a later turn answered a pending approval. */
final class AgentPendingApprovalResolution
{
    /** @param list<string> $callIds */
    public function __construct(
        private readonly bool $approved = false,
        private readonly array $callIds = [],
        private readonly bool $always = false,
        private readonly ?string $byRunId = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            approved: ($data['approved'] ?? false) === true,
            callIds: isset($data['callIds']) && is_array($data['callIds'])
                ? array_values($data['callIds'])
                : [],
            always: ($data['always'] ?? false) === true,
            byRunId: $data['byRunId'] ?? null,
        );
    }

    public function isApproved(): bool
    {
        return $this->approved;
    }

    /**
     * The calls approved. Empty on terms approvals.
     *
     * @return list<string>
     */
    public function getCallIds(): array
    {
        return $this->callIds;
    }

    public function isAlways(): bool
    {
        return $this->always;
    }

    /** The run that answered the approval. */
    public function getByRunId(): ?string
    {
        return $this->byRunId;
    }
}
