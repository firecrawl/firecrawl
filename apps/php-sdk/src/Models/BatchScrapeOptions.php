<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BatchScrapeOptions
{
    private function __construct(
        private readonly ?ScrapeOptions $options = null,
        private readonly string|WebhookConfig|null $webhook = null,
        private readonly ?string $appendToId = null,
        private readonly ?bool $ignoreInvalidURLs = null,
        private readonly ?int $maxConcurrency = null,
        private readonly ?bool $zeroDataRetention = null,
        private readonly ?string $idempotencyKey = null,
        private readonly ?string $integration = null,
    ) {}

    public static function with(
        ?ScrapeOptions $options = null,
        string|WebhookConfig|null $webhook = null,
        ?string $appendToId = null,
        ?bool $ignoreInvalidURLs = null,
        ?int $maxConcurrency = null,
        ?bool $zeroDataRetention = null,
        ?string $idempotencyKey = null,
        ?string $integration = null,
    ): self {
        return new self(
            $options, $webhook, $appendToId, $ignoreInvalidURLs,
            $maxConcurrency, $zeroDataRetention, $idempotencyKey, $integration,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'webhook' => $this->webhook instanceof WebhookConfig ? $this->webhook->toArray() : $this->webhook,
            'appendToId' => $this->appendToId,
            'ignoreInvalidURLs' => $this->ignoreInvalidURLs,
            'maxConcurrency' => $this->maxConcurrency,
            'zeroDataRetention' => $this->zeroDataRetention,
            'integration' => $this->integration,
        ];

        $data = array_filter($fields, fn (mixed $v): bool => $v !== null);

        // Flatten scrape options into body (API expects top-level, not nested)
        if ($this->options !== null) {
            $data = array_merge($this->options->toArray(), $data);
        }

        return $data;
    }

    public function getIdempotencyKey(): ?string
    {
        return $this->idempotencyKey;
    }

    public function getOptions(): ?ScrapeOptions
    {
        return $this->options;
    }
}
