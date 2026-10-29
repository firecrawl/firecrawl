<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BrowserCreateResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $id = null,
        private readonly ?string $cdpUrl = null,
        private readonly ?string $liveViewUrl = null,
        private readonly ?string $interactiveLiveViewUrl = null,
        private readonly ?string $expiresAt = null,
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            success: (bool) ($data['success'] ?? false),
            id: $data['id'] ?? null,
            cdpUrl: $data['cdpUrl'] ?? null,
            liveViewUrl: $data['liveViewUrl'] ?? null,
            interactiveLiveViewUrl: $data['interactiveLiveViewUrl'] ?? null,
            expiresAt: $data['expiresAt'] ?? null,
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

    public function getCdpUrl(): ?string
    {
        return $this->cdpUrl;
    }

    public function getLiveViewUrl(): ?string
    {
        return $this->liveViewUrl;
    }

    public function getExpiresAt(): ?string
    {
        return $this->expiresAt;
    }

    public function getError(): ?string
    {
        return $this->error;
    }

    public function getInteractiveLiveViewUrl(): ?string
    {
        return $this->interactiveLiveViewUrl;
    }
}
