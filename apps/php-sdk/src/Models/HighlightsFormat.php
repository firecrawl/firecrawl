<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class HighlightsFormat
{
    private function __construct(
        private readonly string $query,
    ) {}

    public static function with(string $query): self
    {
        return new self($query);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'type' => 'highlights',
            'query' => $this->query,
        ];
    }

    public function getQuery(): string
    {
        return $this->query;
    }
}
