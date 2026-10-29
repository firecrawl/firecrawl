<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class SearchData
{
    /**
     * @param list<array<string, mixed>> $web
     * @param list<array<string, mixed>> $news
     * @param list<array<string, mixed>> $images
     */
    public function __construct(
        private readonly array $web = [],
        private readonly array $news = [],
        private readonly array $images = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $web = $data['web'] ?? [];
        $news = $data['news'] ?? [];
        $images = $data['images'] ?? [];

        return new self(
            web: is_array($web) ? $web : [],
            news: is_array($news) ? $news : [],
            images: is_array($images) ? $images : [],
        );
    }

    /** @return list<array<string, mixed>> */
    public function getWeb(): array
    {
        return $this->web;
    }

    /** @return list<array<string, mixed>> */
    public function getNews(): array
    {
        return $this->news;
    }

    /** @return list<array<string, mixed>> */
    public function getImages(): array
    {
        return $this->images;
    }
}
