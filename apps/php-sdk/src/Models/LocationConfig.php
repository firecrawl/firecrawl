<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class LocationConfig
{
    private function __construct(
        private readonly ?string $country = null,
        /** @var list<string>|null */
        private readonly ?array $languages = null,
    ) {}

    /**
     * @param list<string>|null $languages
     */
    public static function with(
        ?string $country = null,
        ?array $languages = null,
    ): self {
        return new self($country, $languages);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'country' => $this->country,
            'languages' => $this->languages,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getCountry(): ?string
    {
        return $this->country;
    }

    /** @return list<string>|null */
    public function getLanguages(): ?array
    {
        return $this->languages;
    }
}
