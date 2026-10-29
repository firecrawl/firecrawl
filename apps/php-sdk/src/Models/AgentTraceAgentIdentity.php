<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceAgentIdentity
{
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $role = null,
        private readonly ?string $name = null,
        private readonly ?string $parentId = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? null,
            role: $data['role'] ?? null,
            name: $data['name'] ?? null,
            parentId: $data['parentId'] ?? null,
        );
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getRole(): ?string
    {
        return $this->role;
    }

    public function getName(): ?string
    {
        return $this->name;
    }

    public function getParentId(): ?string
    {
        return $this->parentId;
    }
}
