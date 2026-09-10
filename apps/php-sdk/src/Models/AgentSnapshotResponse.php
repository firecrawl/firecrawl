<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentSnapshotResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $id = null,
        private readonly ?string $snapshotId = null,
        private readonly ?string $snapshot = null,
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            success: (bool) ($data['success'] ?? false),
            id: $data['id'] ?? null,
            snapshotId: $data['snapshotId'] ?? null,
            snapshot: isset($data['snapshot']) ? (string) $data['snapshot'] : null,
            error: $data['error'] ?? null,
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

    public function getSnapshotId(): ?string
    {
        return $this->snapshotId;
    }

    public function getSnapshot(): ?string
    {
        return $this->snapshot;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
