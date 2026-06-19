<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class Document
{
    /**
     * @param array<string, mixed>|null               $metadata
     * @param list<string>|null                        $links
     * @param list<string>|null                        $images
     * @param list<array<string, mixed>>|null          $attributes
     * @param array<string, mixed>|null               $actions
     * @param array<string, mixed>|null               $changeTracking
     * @param array<string, mixed>|null               $branding
     */
    public function __construct(
        private readonly ?string $markdown = null,
        private readonly ?string $html = null,
        private readonly ?string $rawHtml = null,
        private readonly mixed $json = null,
        private readonly ?string $summary = null,
        private readonly ?array $metadata = null,
        private readonly ?array $links = null,
        private readonly ?array $images = null,
        private readonly ?string $screenshot = null,
        private readonly ?string $audio = null,
        private readonly ?string $video = null,
        private readonly ?array $attributes = null,
        private readonly ?array $actions = null,
        private readonly ?string $answer = null,
        private readonly ?string $highlights = null,
        private readonly ?string $warning = null,
        private readonly ?array $changeTracking = null,
        private readonly ?array $branding = null,
        private readonly ?Product $product = null,
        private readonly ?Menu $menu = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            markdown: $data['markdown'] ?? null,
            html: $data['html'] ?? null,
            rawHtml: $data['rawHtml'] ?? null,
            json: $data['json'] ?? null,
            summary: $data['summary'] ?? null,
            metadata: $data['metadata'] ?? null,
            links: $data['links'] ?? null,
            images: $data['images'] ?? null,
            screenshot: $data['screenshot'] ?? null,
            audio: $data['audio'] ?? null,
            video: $data['video'] ?? null,
            attributes: $data['attributes'] ?? null,
            actions: $data['actions'] ?? null,
            answer: $data['answer'] ?? null,
            highlights: $data['highlights'] ?? null,
            warning: $data['warning'] ?? null,
            changeTracking: $data['changeTracking'] ?? null,
            branding: $data['branding'] ?? null,
            product: isset($data['product']) && is_array($data['product'])
                ? Product::fromArray($data['product'])
                : null,
            menu: isset($data['menu']) && is_array($data['menu'])
                ? Menu::fromArray($data['menu'])
                : null,
        );
    }

    public function getMarkdown(): ?string
    {
        return $this->markdown;
    }

    public function getHtml(): ?string
    {
        return $this->html;
    }

    public function getRawHtml(): ?string
    {
        return $this->rawHtml;
    }

    public function getJson(): mixed
    {
        return $this->json;
    }

    public function getSummary(): ?string
    {
        return $this->summary;
    }

    /** @return array<string, mixed>|null */
    public function getMetadata(): ?array
    {
        return $this->metadata;
    }

    /** @return list<string>|null */
    public function getLinks(): ?array
    {
        return $this->links;
    }

    /** @return list<string>|null */
    public function getImages(): ?array
    {
        return $this->images;
    }

    public function getScreenshot(): ?string
    {
        return $this->screenshot;
    }

    public function getAudio(): ?string
    {
        return $this->audio;
    }

    public function getVideo(): ?string
    {
        return $this->video;
    }

    /** @return list<array<string, mixed>>|null */
    public function getAttributes(): ?array
    {
        return $this->attributes;
    }

    /** @return array<string, mixed>|null */
    public function getActions(): ?array
    {
        return $this->actions;
    }

    public function getWarning(): ?string
    {
        return $this->warning;
    }

    public function getAnswer(): ?string
    {
        return $this->answer;
    }

    public function getHighlights(): ?string
    {
        return $this->highlights;
    }

    /** @return array<string, mixed>|null */
    public function getChangeTracking(): ?array
    {
        return $this->changeTracking;
    }

    /** @return array<string, mixed>|null */
    public function getBranding(): ?array
    {
        return $this->branding;
    }

    public function getProduct(): ?Product
    {
        return $this->product;
    }

    public function getMenu(): ?Menu
    {
        return $this->menu;
    }
}
