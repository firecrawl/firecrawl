<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BrowserSession
{
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $status = null,
        private readonly ?string $cdpUrl = null,
        private readonly ?string $liveViewUrl = null,
        private readonly bool $streamWebView = false,
        private readonly ?string $createdAt = null,
        private readonly ?string $lastActivity = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? null,
            status: $data['status'] ?? null,
            cdpUrl: $data['cdpUrl'] ?? null,
            liveViewUrl: $data['liveViewUrl'] ?? null,
            streamWebView: (bool) ($data['streamWebView'] ?? false),
            createdAt: $data['createdAt'] ?? null,
            lastActivity: $data['lastActivity'] ?? null,
        );
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getStatus(): ?string
    {
        return $this->status;
    }

    public function getCdpUrl(): ?string
    {
        return $this->cdpUrl;
    }

    public function getLiveViewUrl(): ?string
    {
        return $this->liveViewUrl;
    }

    public function isStreamWebView(): bool
    {
        return $this->streamWebView;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function getLastActivity(): ?string
    {
        return $this->lastActivity;
    }
}
