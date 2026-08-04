<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class DocumentPage
{
    private function __construct(
        private readonly int $pageNumber,
        private readonly string $markdown,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            pageNumber: (int) ($data['pageNumber'] ?? 0),
            markdown: (string) ($data['markdown'] ?? ''),
        );
    }

    public function getPageNumber(): int
    {
        return $this->pageNumber;
    }

    public function getMarkdown(): string
    {
        return $this->markdown;
    }
}
