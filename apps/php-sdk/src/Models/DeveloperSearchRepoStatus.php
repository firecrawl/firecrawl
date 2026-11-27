<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** Whether a requested repository is indexed, and which result kinds it has. */
final class DeveloperSearchRepoStatus
{
    /** @param array{issue: bool, pullRequest: bool, readme: bool} $types */
    public function __construct(
        private readonly string $repo = '',
        private readonly bool $indexed = false,
        private readonly array $types = ['issue' => false, 'pullRequest' => false, 'readme' => false],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $types = is_array($data['types'] ?? null) ? $data['types'] : [];

        return new self(
            repo: (string) ($data['repo'] ?? ''),
            indexed: (bool) ($data['indexed'] ?? false),
            types: [
                'issue' => (bool) ($types['issue'] ?? false),
                'pullRequest' => (bool) ($types['pullRequest'] ?? false),
                'readme' => (bool) ($types['readme'] ?? false),
            ],
        );
    }

    public function getRepo(): string
    {
        return $this->repo;
    }

    public function isIndexed(): bool
    {
        return $this->indexed;
    }

    /** @return array{issue: bool, pullRequest: bool, readme: bool} */
    public function getTypes(): array
    {
        return $this->types;
    }
}
