<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class WebhookConfig
{
    private function __construct(
        private readonly string $url,
        /** @var array<string, string>|null */
        private readonly ?array $headers = null,
        /** @var array<string, string>|null */
        private readonly ?array $metadata = null,
        /** @var list<string>|null */
        private readonly ?array $events = null,
    ) {}

    /**
     * @param array<string, string>|null $headers
     * @param array<string, string>|null $metadata
     * @param list<string>|null          $events
     */
    public static function with(
        string $url,
        ?array $headers = null,
        ?array $metadata = null,
        ?array $events = null,
    ): self {
        return new self($url, $headers, $metadata, $events);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'url' => $this->url,
            'headers' => $this->headers,
            'metadata' => $this->metadata,
            'events' => $this->events,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getUrl(): string
    {
        return $this->url;
    }

    /** @return array<string, string>|null */
    public function getHeaders(): ?array
    {
        return $this->headers;
    }

    /** @return array<string, string>|null */
    public function getMetadata(): ?array
    {
        return $this->metadata;
    }

    /** @return list<string>|null */
    public function getEvents(): ?array
    {
        return $this->events;
    }
}
