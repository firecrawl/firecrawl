<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class MapOptions
{
    private function __construct(
        private readonly ?string $search = null,
        private readonly ?string $sitemap = null,
        private readonly ?bool $includeSubdomains = null,
        private readonly ?bool $ignoreQueryParameters = null,
        private readonly ?int $limit = null,
        private readonly ?int $timeout = null,
        private readonly ?string $integration = null,
        private readonly ?LocationConfig $location = null,
        private readonly ?AuditMetadata $auditMetadata = null,
    ) {}

    public static function with(
        ?string $search = null,
        ?string $sitemap = null,
        ?bool $includeSubdomains = null,
        ?bool $ignoreQueryParameters = null,
        ?int $limit = null,
        ?int $timeout = null,
        ?string $integration = null,
        ?LocationConfig $location = null,
        ?AuditMetadata $auditMetadata = null,
    ): self {
        return new self(
            $search, $sitemap, $includeSubdomains, $ignoreQueryParameters,
            $limit, $timeout, $integration, $location, $auditMetadata,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'search' => $this->search,
            'sitemap' => $this->sitemap,
            'includeSubdomains' => $this->includeSubdomains,
            'ignoreQueryParameters' => $this->ignoreQueryParameters,
            'limit' => $this->limit,
            'timeout' => $this->timeout,
            'integration' => $this->integration,
            'location' => $this->location?->toArray(),
            'auditMetadata' => $this->auditMetadata?->toArray(),
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
