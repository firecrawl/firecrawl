<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** One matched passage of a developer search result. */
final class DeveloperSearchPassage
{
    public function __construct(
        private readonly string $text = '',
        private readonly ?string $citationUrl = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            text: (string) ($data['text'] ?? ''),
            citationUrl: isset($data['citation_url']) ? (string) $data['citation_url'] : null,
        );
    }

    public function getText(): string
    {
        return $this->text;
    }

    public function getCitationUrl(): ?string
    {
        return $this->citationUrl;
    }
}
