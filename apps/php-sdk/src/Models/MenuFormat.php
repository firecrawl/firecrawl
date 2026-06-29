<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class MenuFormat
{
    private function __construct(
        private readonly bool $modifiers,
    ) {}

    public static function with(bool $modifiers = true): self
    {
        return new self($modifiers);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'type' => 'menu',
            'modifiers' => $this->modifiers,
        ];
    }

    public function getModifiers(): bool
    {
        return $this->modifiers;
    }
}
