<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class ScreenshotFormat
{
    private function __construct(
        private readonly ?bool $fullPage = null,
        private readonly ?int $quality = null,
    ) {}

    public static function with(
        ?bool $fullPage = null,
        ?int $quality = null,
    ): self {
        return new self($fullPage, $quality);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'type' => 'screenshot',
            'fullPage' => $this->fullPage,
            'quality' => $this->quality,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getFullPage(): ?bool
    {
        return $this->fullPage;
    }

    public function getQuality(): ?int
    {
        return $this->quality;
    }
}
