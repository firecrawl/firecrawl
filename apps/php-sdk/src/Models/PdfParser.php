<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class PdfParser
{
    private function __construct(
        private readonly ?string $mode = null,
        private readonly ?int $maxPages = null,
        private readonly ?bool $pageMarkdown = null,
    ) {}

    public static function with(
        ?string $mode = null,
        ?int $maxPages = null,
        ?bool $pageMarkdown = null,
    ): self {
        return new self($mode, $maxPages, $pageMarkdown);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'type' => 'pdf',
            'mode' => $this->mode,
            'maxPages' => $this->maxPages,
            'pageMarkdown' => $this->pageMarkdown,
        ], static fn (mixed $value): bool => $value !== null);
    }
}
