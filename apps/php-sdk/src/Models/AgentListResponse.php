<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentListResponse
{
    /**
     * @param list<AgentListItem> $agents
     */
    public function __construct(
        private readonly bool $success = false,
        private readonly array $agents = [],
        private readonly ?string $next = null,
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $agents = [];
        $rawAgents = $data['agents'] ?? [];
        if (is_array($rawAgents)) {
            foreach ($rawAgents as $agent) {
                $agents[] = AgentListItem::fromArray($agent);
            }
        }

        return new self(
            success: (bool) ($data['success'] ?? false),
            agents: $agents,
            next: $data['next'] ?? null,
            error: $data['error'] ?? null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    /** @return list<AgentListItem> */
    public function getAgents(): array
    {
        return $this->agents;
    }

    /**
     * Absolute URL of the next page; only present when more pages exist.
     */
    public function getNext(): ?string
    {
        return $this->next;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
