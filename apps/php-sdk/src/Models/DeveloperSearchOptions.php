<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** Filters for {@see \Firecrawl\Client\FirecrawlClient::developerSearch()}. Unset fields are omitted from the request. */
final class DeveloperSearchOptions
{
    /**
     * @param list<string>|null $types
     * @param list<string>|null $repos
     * @param list<string>|null $sources
     * @param list<string>|null $topic
     */
    private function __construct(
        private readonly ?int $k = null,
        private readonly ?int $passages = null,
        private readonly ?array $types = null,
        private readonly ?array $repos = null,
        private readonly ?array $sources = null,
        private readonly ?string $language = null,
        private readonly ?array $topic = null,
        private readonly ?string $license = null,
        private readonly ?int $minStars = null,
        private readonly ?int $maxStars = null,
        private readonly ?bool $archived = null,
        private readonly ?bool $fork = null,
        private readonly ?string $skills = null,
    ) {}

    /**
     * @param int|null $k Total ranked results, 1 to 100 (default 10).
     * @param int|null $passages Passages per result, 1 to 5 (default 1).
     * @param list<string>|null $types Result kinds: "doc", "issue", "pull_request", "readme" (default all).
     * @param list<string>|null $repos GitHub owner/name filters, at most 20.
     * @param list<string>|null $sources Developer documentation source IDs, at most 20.
     * @param string|null $language One case-insensitive GitHub Linguist primary language.
     * @param list<string>|null $topic Repository topics that must all match, at most 8.
     * @param string|null $license One case-insensitive SPDX repository license identifier.
     * @param string|null $skills "only" returns packaged agent-skill evidence only.
     */
    public static function with(
        ?int $k = null,
        ?int $passages = null,
        ?array $types = null,
        ?array $repos = null,
        ?array $sources = null,
        ?string $language = null,
        ?array $topic = null,
        ?string $license = null,
        ?int $minStars = null,
        ?int $maxStars = null,
        ?bool $archived = null,
        ?bool $fork = null,
        ?string $skills = null,
    ): self {
        return new self(
            $k, $passages, $types, $repos, $sources, $language, $topic,
            $license, $minStars, $maxStars, $archived, $fork, $skills,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'k' => $this->k,
            'passages' => $this->passages,
            'types' => $this->types,
            'repos' => $this->repos,
            'sources' => $this->sources,
            'language' => $this->language,
            'topic' => $this->topic,
            'license' => $this->license,
            'min_stars' => $this->minStars,
            'max_stars' => $this->maxStars,
            'archived' => $this->archived,
            'fork' => $this->fork,
            'skills' => $this->skills,
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
