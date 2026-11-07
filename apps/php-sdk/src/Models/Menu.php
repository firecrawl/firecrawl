<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * Structured menu information extracted via the `menu` scrape format.
 *
 * Pricing, availability, and images live on individual items; the top-level
 * menu carries the merchant profile and descriptive fields only. Sections and
 * their items are inlined as associative arrays.
 */
final class Menu
{
    /**
     * @param array<string, mixed>       $merchant
     * @param list<array<string, mixed>> $sections
     */
    public function __construct(
        private readonly bool $isMenu,
        private readonly float $confidence,
        private readonly string $sourceUrl,
        private readonly array $merchant = [],
        private readonly ?string $currency = null,
        private readonly array $sections = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            isMenu: (bool) ($data['isMenu'] ?? false),
            confidence: (float) ($data['confidence'] ?? 0),
            sourceUrl: (string) ($data['sourceUrl'] ?? ''),
            merchant: self::normalizeMerchant($data['merchant'] ?? null),
            currency: ($data['currency'] ?? null) !== null ? (string) $data['currency'] : null,
            sections: self::normalizeSections($data['sections'] ?? []),
        );
    }

    /**
     * @param mixed $merchant
     * @return array<string, mixed>
     */
    private static function normalizeMerchant(mixed $merchant): array
    {
        if (!is_array($merchant)) {
            return [];
        }

        $entry = ['name' => (string) ($merchant['name'] ?? '')];
        if (array_key_exists('type', $merchant)) {
            $entry['type'] = $merchant['type'] !== null ? (string) $merchant['type'] : null;
        }
        // Location is an arbitrary structure; pass it through untouched.
        if (array_key_exists('location', $merchant)) {
            $entry['location'] = $merchant['location'];
        }

        return $entry;
    }

    /**
     * @param mixed $images
     * @return list<array{url: string, alt?: string|null}>
     */
    private static function normalizeImages(mixed $images): array
    {
        if (!is_array($images)) {
            return [];
        }

        $result = [];
        foreach ($images as $image) {
            if (!is_array($image) || !isset($image['url'])) {
                continue;
            }
            $entry = ['url' => (string) $image['url']];
            if (array_key_exists('alt', $image)) {
                $entry['alt'] = $image['alt'] !== null ? (string) $image['alt'] : null;
            }
            $result[] = $entry;
        }

        return $result;
    }

    /**
     * @param mixed $price
     * @return array{amount: float, currency?: string|null, formatted?: string|null}|null
     */
    private static function normalizePrice(mixed $price): ?array
    {
        if (!is_array($price) || !isset($price['amount'])) {
            return null;
        }

        $entry = ['amount' => (float) $price['amount']];
        if (array_key_exists('currency', $price)) {
            $entry['currency'] = $price['currency'] !== null ? (string) $price['currency'] : null;
        }
        if (array_key_exists('formatted', $price)) {
            $entry['formatted'] = $price['formatted'] !== null ? (string) $price['formatted'] : null;
        }

        return $entry;
    }

    /**
     * @param mixed $availability
     * @return array{inStock: bool, text?: string|null}
     */
    private static function normalizeAvailability(mixed $availability): array
    {
        if (!is_array($availability)) {
            return ['inStock' => false];
        }

        $entry = ['inStock' => (bool) ($availability['inStock'] ?? false)];
        if (array_key_exists('text', $availability)) {
            $entry['text'] = $availability['text'] !== null ? (string) $availability['text'] : null;
        }

        return $entry;
    }

    /**
     * @param mixed $items
     * @return list<array<string, mixed>>
     */
    private static function normalizeItems(mixed $items): array
    {
        if (!is_array($items)) {
            return [];
        }

        $result = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $entry = [];
            foreach (['id', 'name', 'description', 'url'] as $key) {
                if (isset($item[$key])) {
                    $entry[$key] = (string) $item[$key];
                }
            }
            // sourceUrl is always present on an item.
            $entry['sourceUrl'] = (string) ($item['sourceUrl'] ?? '');
            if (isset($item['images'])) {
                $entry['images'] = self::normalizeImages($item['images']);
            }
            if (($price = self::normalizePrice($item['price'] ?? null)) !== null) {
                $entry['price'] = $price;
            }
            // Availability is always present on an item.
            $entry['availability'] = self::normalizeAvailability($item['availability'] ?? null);
            if (isset($item['dietary']) && is_array($item['dietary'])) {
                $entry['dietary'] = array_map(
                    static fn (mixed $d): string => (string) $d,
                    array_values($item['dietary']),
                );
            }
            if (isset($item['calories'])) {
                $entry['calories'] = (float) $item['calories'];
            }
            // optionGroups is an arbitrary structure; pass it through untouched.
            if (isset($item['optionGroups']) && is_array($item['optionGroups'])) {
                $entry['optionGroups'] = $item['optionGroups'];
            }
            if (
                is_array($item['identifiers'] ?? null)
                && isset($item['identifiers']['merchantItemId'])
            ) {
                $entry['identifiers'] = [
                    'merchantItemId' => (string) $item['identifiers']['merchantItemId'],
                ];
            }

            $result[] = $entry;
        }

        return $result;
    }

    /**
     * @param mixed $sections
     * @return list<array<string, mixed>>
     */
    private static function normalizeSections(mixed $sections): array
    {
        if (!is_array($sections)) {
            return [];
        }

        $result = [];
        foreach ($sections as $section) {
            if (!is_array($section)) {
                continue;
            }

            $entry = [];
            foreach (['id', 'name', 'description'] as $key) {
                if (isset($section[$key])) {
                    $entry[$key] = (string) $section[$key];
                }
            }
            $entry['items'] = self::normalizeItems($section['items'] ?? []);

            $result[] = $entry;
        }

        return $result;
    }

    public function getIsMenu(): bool
    {
        return $this->isMenu;
    }

    public function getConfidence(): float
    {
        return $this->confidence;
    }

    public function getSourceUrl(): string
    {
        return $this->sourceUrl;
    }

    /** @return array<string, mixed> */
    public function getMerchant(): array
    {
        return $this->merchant;
    }

    public function getCurrency(): ?string
    {
        return $this->currency;
    }

    /** @return list<array<string, mixed>> */
    public function getSections(): array
    {
        return $this->sections;
    }
}
