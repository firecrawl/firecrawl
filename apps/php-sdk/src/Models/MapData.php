<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class MapData
{
    /**
     * @param list<array<string, mixed>> $links
     */
    public function __construct(
        private readonly array $links = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $rawLinks = $data['links'] ?? [];
        if (!is_array($rawLinks)) {
            return new self(links: []);
        }
        $normalized = [];

        foreach ($rawLinks as $link) {
            if (is_string($link)) {
                $normalized[] = ['url' => $link];
            } elseif (is_array($link)) {
                $normalized[] = $link;
            }
        }

        return new self(links: $normalized);
    }

    /** @return list<array<string, mixed>> */
    public function getLinks(): array
    {
        return $this->links;
    }
}
