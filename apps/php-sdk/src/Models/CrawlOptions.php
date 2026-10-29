<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class CrawlOptions
{
    /**
     * @param list<string>|null $excludePaths
     * @param list<string>|null $includePaths
     */
    private function __construct(
        private readonly ?string $prompt = null,
        private readonly ?array $excludePaths = null,
        private readonly ?array $includePaths = null,
        private readonly ?int $maxDiscoveryDepth = null,
        private readonly ?string $sitemap = null,
        private readonly ?bool $ignoreQueryParameters = null,
        private readonly ?bool $deduplicateSimilarURLs = null,
        private readonly ?int $limit = null,
        private readonly ?bool $crawlEntireDomain = null,
        private readonly ?bool $allowExternalLinks = null,
        private readonly ?bool $allowSubdomains = null,
        private readonly ?int $delay = null,
        private readonly ?int $maxConcurrency = null,
        private readonly string|WebhookConfig|null $webhook = null,
        private readonly ?ScrapeOptions $scrapeOptions = null,
        private readonly ?bool $regexOnFullURL = null,
        private readonly ?bool $zeroDataRetention = null,
        private readonly ?string $integration = null,
        private readonly ?string $idempotencyKey = null,
    ) {}

    /**
     * @param list<string>|null $excludePaths
     * @param list<string>|null $includePaths
     */
    public static function with(
        ?string $prompt = null,
        ?array $excludePaths = null,
        ?array $includePaths = null,
        ?int $maxDiscoveryDepth = null,
        ?string $sitemap = null,
        ?bool $ignoreQueryParameters = null,
        ?bool $deduplicateSimilarURLs = null,
        ?int $limit = null,
        ?bool $crawlEntireDomain = null,
        ?bool $allowExternalLinks = null,
        ?bool $allowSubdomains = null,
        ?int $delay = null,
        ?int $maxConcurrency = null,
        string|WebhookConfig|null $webhook = null,
        ?ScrapeOptions $scrapeOptions = null,
        ?bool $regexOnFullURL = null,
        ?bool $zeroDataRetention = null,
        ?string $integration = null,
        ?string $idempotencyKey = null,
    ): self {
        return new self(
            $prompt, $excludePaths, $includePaths, $maxDiscoveryDepth, $sitemap,
            $ignoreQueryParameters, $deduplicateSimilarURLs, $limit, $crawlEntireDomain,
            $allowExternalLinks, $allowSubdomains, $delay, $maxConcurrency, $webhook,
            $scrapeOptions, $regexOnFullURL, $zeroDataRetention, $integration,
            $idempotencyKey,
        );
    }

    public function getIdempotencyKey(): ?string
    {
        return $this->idempotencyKey;
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'prompt' => $this->prompt,
            'excludePaths' => $this->excludePaths,
            'includePaths' => $this->includePaths,
            'maxDiscoveryDepth' => $this->maxDiscoveryDepth,
            'sitemap' => $this->sitemap,
            'ignoreQueryParameters' => $this->ignoreQueryParameters,
            'deduplicateSimilarURLs' => $this->deduplicateSimilarURLs,
            'limit' => $this->limit,
            'crawlEntireDomain' => $this->crawlEntireDomain,
            'allowExternalLinks' => $this->allowExternalLinks,
            'allowSubdomains' => $this->allowSubdomains,
            'delay' => $this->delay,
            'maxConcurrency' => $this->maxConcurrency,
            'webhook' => $this->webhook instanceof WebhookConfig ? $this->webhook->toArray() : $this->webhook,
            'scrapeOptions' => $this->scrapeOptions?->toArray(),
            'regexOnFullURL' => $this->regexOnFullURL,
            'zeroDataRetention' => $this->zeroDataRetention,
            'integration' => $this->integration,
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
