<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class CrawlResponse
{
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $url = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? null,
            url: $data['url'] ?? null,
        );
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getUrl(): ?string
    {
        return $this->url;
    }
}
