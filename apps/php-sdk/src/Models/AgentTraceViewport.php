<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceViewport
{
    public function __construct(
        private readonly int $width = 0,
        private readonly int $height = 0,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            width: (int) ($data['width'] ?? 0),
            height: (int) ($data['height'] ?? 0),
        );
    }

    public function getWidth(): int
    {
        return $this->width;
    }

    public function getHeight(): int
    {
        return $this->height;
    }
}
