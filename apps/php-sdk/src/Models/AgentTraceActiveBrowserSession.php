<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceActiveBrowserSession
{
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $liveViewUrl = null,
        private readonly ?AgentTraceViewport $viewport = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? null,
            liveViewUrl: $data['liveViewUrl'] ?? null,
            viewport: isset($data['viewport']) && is_array($data['viewport'])
                ? AgentTraceViewport::fromArray($data['viewport'])
                : null,
        );
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getLiveViewUrl(): ?string
    {
        return $this->liveViewUrl;
    }

    public function getViewport(): ?AgentTraceViewport
    {
        return $this->viewport;
    }
}
