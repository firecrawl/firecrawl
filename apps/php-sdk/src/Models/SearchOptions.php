<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class SearchOptions
{
    /**
     * @param list<mixed>|null $sources
     * @param list<mixed>|null $categories
     * @param list<string>|null $includeDomains
     * @param list<string>|null $excludeDomains
     */
    private function __construct(
        private readonly ?array $sources = null,
        private readonly ?array $categories = null,
        private readonly ?int $limit = null,
        private readonly ?string $tbs = null,
        private readonly ?string $location = null,
        private readonly ?bool $ignoreInvalidURLs = null,
        private readonly ?int $timeout = null,
        private readonly ?ScrapeOptions $scrapeOptions = null,
        private readonly ?string $integration = null,
        private readonly ?array $includeDomains = null,
        private readonly ?array $excludeDomains = null,
        private readonly ?bool $highlights = null,
    ) {}

    /**
     * @param list<mixed>|null $sources
     * @param list<mixed>|null $categories
     * @param list<string>|null $includeDomains
     * @param list<string>|null $excludeDomains
     */
    public static function with(
        ?array $sources = null,
        ?array $categories = null,
        ?int $limit = null,
        ?string $tbs = null,
        ?string $location = null,
        ?bool $ignoreInvalidURLs = null,
        ?int $timeout = null,
        ?ScrapeOptions $scrapeOptions = null,
        ?string $integration = null,
        ?array $includeDomains = null,
        ?array $excludeDomains = null,
        ?bool $highlights = null,
    ): self {
        return new self(
            $sources, $categories, $limit, $tbs, $location, $ignoreInvalidURLs,
            $timeout, $scrapeOptions, $integration, $includeDomains, $excludeDomains,
            $highlights,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'sources' => $this->sources,
            'categories' => $this->categories,
            'includeDomains' => $this->includeDomains,
            'excludeDomains' => $this->excludeDomains,
            'limit' => $this->limit,
            'tbs' => $this->tbs,
            'location' => $this->location,
            'ignoreInvalidURLs' => $this->ignoreInvalidURLs,
            'timeout' => $this->timeout,
            'highlights' => $this->highlights,
            'scrapeOptions' => $this->scrapeOptions?->toArray(),
            'integration' => $this->integration,
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
