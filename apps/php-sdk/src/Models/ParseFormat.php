<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * A file format accepted by the parse endpoint.
 *
 * The kind is kept as a plain string so values added by the API later still
 * parse; compare it against the KIND_* constants.
 */
final class ParseFormat
{
    public const KIND_DOCUMENT = 'document';
    public const KIND_IMAGE = 'image';

    /**
     * @param list<string> $extensions
     * @param list<string> $mimeTypes
     */
    public function __construct(
        private readonly string $format = '',
        private readonly string $kind = '',
        private readonly array $extensions = [],
        private readonly array $mimeTypes = [],
        private readonly bool $available = false,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            format: (string) ($data['format'] ?? ''),
            kind: (string) ($data['kind'] ?? ''),
            extensions: self::stringList($data['extensions'] ?? []),
            mimeTypes: self::stringList($data['mimeTypes'] ?? []),
            available: ($data['available'] ?? false) === true,
        );
    }

    public function getFormat(): string
    {
        return $this->format;
    }

    public function getKind(): string
    {
        return $this->kind;
    }

    public function isDocument(): bool
    {
        return $this->kind === self::KIND_DOCUMENT;
    }

    public function isImage(): bool
    {
        return $this->kind === self::KIND_IMAGE;
    }

    /** @return list<string> */
    public function getExtensions(): array
    {
        return $this->extensions;
    }

    /** @return list<string> */
    public function getMimeTypes(): array
    {
        return $this->mimeTypes;
    }

    public function isAvailable(): bool
    {
        return $this->available;
    }

    /** @return list<string> */
    private static function stringList(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        return array_values(array_map('strval', array_filter($value, 'is_scalar')));
    }
}
