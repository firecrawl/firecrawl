<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * Structured product information extracted via the `product` scrape format.
 *
 * Pricing, availability, and images live on individual variants; the
 * top-level product carries identity and descriptive fields only.
 */
final class Product
{
    /**
     * @param list<array<string, mixed>> $variants
     */
    public function __construct(
        private readonly string $title,
        private readonly string $url,
        private readonly ?string $brand = null,
        private readonly ?string $category = null,
        private readonly ?string $description = null,
        private readonly array $variants = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            title: (string) ($data['title'] ?? ''),
            url: (string) ($data['url'] ?? ''),
            brand: ($data['brand'] ?? null) !== null ? (string) $data['brand'] : null,
            category: ($data['category'] ?? null) !== null ? (string) $data['category'] : null,
            description: ($data['description'] ?? null) !== null ? (string) $data['description'] : null,
            variants: self::normalizeVariants($data['variants'] ?? []),
        );
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
     * @param mixed $variants
     * @return list<array<string, mixed>>
     */
    private static function normalizeVariants(mixed $variants): array
    {
        if (!is_array($variants)) {
            return [];
        }

        $result = [];
        foreach ($variants as $variant) {
            if (!is_array($variant)) {
                continue;
            }

            $entry = [];
            foreach (['id', 'sku', 'title'] as $key) {
                if (isset($variant[$key])) {
                    $entry[$key] = (string) $variant[$key];
                }
            }
            if (isset($variant['values']) && is_array($variant['values'])) {
                $entry['values'] = $variant['values'];
            }
            if (($price = self::normalizePrice($variant['price'] ?? null)) !== null) {
                $entry['price'] = $price;
            }
            if (
                is_array($variant['sale'] ?? null)
                && ($originalPrice = self::normalizePrice($variant['sale']['originalPrice'] ?? null)) !== null
            ) {
                $entry['sale'] = ['originalPrice' => $originalPrice];
            }
            // Availability is always present on a variant.
            $entry['availability'] = self::normalizeAvailability($variant['availability'] ?? null);
            if (isset($variant['images'])) {
                $entry['images'] = self::normalizeImages($variant['images']);
            }

            $result[] = $entry;
        }

        return $result;
    }

    public function getTitle(): string
    {
        return $this->title;
    }

    public function getUrl(): string
    {
        return $this->url;
    }

    public function getBrand(): ?string
    {
        return $this->brand;
    }

    public function getCategory(): ?string
    {
        return $this->category;
    }

    public function getDescription(): ?string
    {
        return $this->description;
    }

    /** @return list<array<string, mixed>> */
    public function getVariants(): array
    {
        return $this->variants;
    }
}
