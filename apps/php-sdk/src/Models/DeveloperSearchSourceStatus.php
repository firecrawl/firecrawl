<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** Whether a requested documentation source is indexed. */
final class DeveloperSearchSourceStatus
{
    public function __construct(
        private readonly string $source = '',
        private readonly bool $indexed = false,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            source: (string) ($data['source'] ?? ''),
            indexed: (bool) ($data['indexed'] ?? false),
        );
    }

    public function getSource(): string
    {
        return $this->source;
    }

    public function isIndexed(): bool
    {
        return $this->indexed;
    }
}
