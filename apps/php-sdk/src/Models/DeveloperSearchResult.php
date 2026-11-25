<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** One ranked developer search result. */
final class DeveloperSearchResult
{
    /**
     * @param list<DeveloperSearchPassage> $passages
     * @param string|array<string, mixed>|null $license
     */
    public function __construct(
        private readonly string $id = '',
        private readonly string $url = '',
        private readonly ?string $title = null,
        private readonly array $passages = [],
        private readonly string|array|null $license = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $passages = is_array($data['passages'] ?? null) ? $data['passages'] : [];
        $license = $data['license'] ?? null;

        return new self(
            id: (string) ($data['id'] ?? ''),
            url: (string) ($data['url'] ?? ''),
            title: isset($data['title']) ? (string) $data['title'] : null,
            passages: array_map(
                static fn (array $passage): DeveloperSearchPassage => DeveloperSearchPassage::fromArray($passage),
                array_values(array_filter($passages, 'is_array')),
            ),
            license: is_string($license) || is_array($license) ? $license : null,
        );
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getUrl(): string
    {
        return $this->url;
    }

    public function getTitle(): ?string
    {
        return $this->title;
    }

    /** @return list<DeveloperSearchPassage> */
    public function getPassages(): array
    {
        return $this->passages;
    }

    /**
     * An SPDX identifier string, or a disclosure object (as an array) when the license is not a plain identifier.
     *
     * @return string|array<string, mixed>|null
     */
    public function getLicense(): string|array|null
    {
        return $this->license;
    }
}
