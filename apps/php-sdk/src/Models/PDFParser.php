<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * PDF parser configuration for use in ScrapeOptions / ParseOptions parsers.
 */
final class PDFParser
{
    private function __construct(
        private readonly ?string $mode = null,
        private readonly ?int $maxPages = null,
        private readonly ?bool $pages = null,
        private readonly ?bool $blocks = null,
        private readonly ?bool $pageMarkers = null,
    ) {}

    public static function with(
        ?string $mode = null,
        ?int $maxPages = null,
        ?bool $pages = null,
        ?bool $blocks = null,
        ?bool $pageMarkers = null,
    ): self {
        return new self($mode, $maxPages, $pages, $blocks, $pageMarkers);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'type' => 'pdf',
            'mode' => $this->mode,
            'maxPages' => $this->maxPages,
            'pages' => $this->pages,
            'blocks' => $this->blocks,
            'pageMarkers' => $this->pageMarkers,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getMode(): ?string
    {
        return $this->mode;
    }

    public function getMaxPages(): ?int
    {
        return $this->maxPages;
    }

    public function getPages(): ?bool
    {
        return $this->pages;
    }

    public function getBlocks(): ?bool
    {
        return $this->blocks;
    }

    public function getPageMarkers(): ?bool
    {
        return $this->pageMarkers;
    }
}
