<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceArtifactChange
{
    /** @param list<string>|null $changedFields */
    public function __construct(
        private readonly ?string $kind = null,
        private readonly ?string $artifactId = null,
        private readonly ?string $path = null,
        private readonly ?string $snapshotId = null,
        private readonly ?string $change = null,
        private readonly ?array $changedFields = null,
        private readonly ?int $itemCount = null,
        private readonly ?string $sourceToolCallId = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            kind: $data['kind'] ?? null,
            artifactId: $data['artifactId'] ?? null,
            path: $data['path'] ?? null,
            snapshotId: $data['snapshotId'] ?? null,
            change: $data['change'] ?? null,
            changedFields: isset($data['changedFields']) && is_array($data['changedFields'])
                ? array_values($data['changedFields'])
                : null,
            itemCount: isset($data['itemCount']) ? (int) $data['itemCount'] : null,
            sourceToolCallId: $data['sourceToolCallId'] ?? null,
        );
    }

    public function getKind(): ?string
    {
        return $this->kind;
    }

    public function getArtifactId(): ?string
    {
        return $this->artifactId;
    }

    public function getPath(): ?string
    {
        return $this->path;
    }

    public function getSnapshotId(): ?string
    {
        return $this->snapshotId;
    }

    public function getChange(): ?string
    {
        return $this->change;
    }

    /** @return list<string>|null */
    public function getChangedFields(): ?array
    {
        return $this->changedFields;
    }

    public function getItemCount(): ?int
    {
        return $this->itemCount;
    }

    public function getSourceToolCallId(): ?string
    {
        return $this->sourceToolCallId;
    }
}
