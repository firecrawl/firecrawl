<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class ConcurrencyCheck
{
    public function __construct(
        private readonly int $concurrency = 0,
        private readonly int $maxConcurrency = 0,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            concurrency: (int) ($data['concurrency'] ?? 0),
            maxConcurrency: (int) ($data['maxConcurrency'] ?? 0),
        );
    }

    public function getConcurrency(): int
    {
        return $this->concurrency;
    }

    public function getMaxConcurrency(): int
    {
        return $this->maxConcurrency;
    }
}
