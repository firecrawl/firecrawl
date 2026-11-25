<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** Response from {@see \Firecrawl\Client\FirecrawlClient::developerSearch()}. */
final class DeveloperSearchResponse
{
    /**
     * @param list<DeveloperSearchResult> $results
     * @param list<DeveloperSearchRepoStatus>|null $repos
     * @param list<DeveloperSearchSourceStatus>|null $sources
     */
    public function __construct(
        private readonly bool $success = true,
        private readonly bool $partial = false,
        private readonly array $results = [],
        private readonly ?array $repos = null,
        private readonly ?array $sources = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $list = static fn (mixed $items): array => is_array($items) ? array_values(array_filter($items, 'is_array')) : [];

        return new self(
            success: (bool) ($data['success'] ?? true),
            partial: (bool) ($data['partial'] ?? false),
            results: array_map(DeveloperSearchResult::fromArray(...), $list($data['results'] ?? null)),
            repos: is_array($data['repos'] ?? null)
                ? array_map(DeveloperSearchRepoStatus::fromArray(...), $list($data['repos']))
                : null,
            sources: is_array($data['sources'] ?? null)
                ? array_map(DeveloperSearchSourceStatus::fromArray(...), $list($data['sources']))
                : null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    /** Whether the API marked the response as partial. */
    public function isPartial(): bool
    {
        return $this->partial;
    }

    /** @return list<DeveloperSearchResult> */
    public function getResults(): array
    {
        return $this->results;
    }

    /**
     * Present only when the repos filter was set.
     *
     * @return list<DeveloperSearchRepoStatus>|null
     */
    public function getRepos(): ?array
    {
        return $this->repos;
    }

    /**
     * Present only when the sources filter was set.
     *
     * @return list<DeveloperSearchSourceStatus>|null
     */
    public function getSources(): ?array
    {
        return $this->sources;
    }
}
