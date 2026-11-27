<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class RedactPIIOptions
{
    /** Model only. Best precision, cleanest redacted output. */
    public const MODE_ACCURATE = 'accurate';

    /** Model plus Presidio and spaCy. Higher recall for compliance use cases. */
    public const MODE_AGGRESSIVE = 'aggressive';

    /** Presidio only, no model call. Roughly twice the throughput, lower F1. */
    public const MODE_FAST = 'fast';

    /** Replace spans with <KIND> placeholders. */
    public const REPLACE_STYLE_TAG = 'tag';

    /** Replace spans with asterisks of equal length. */
    public const REPLACE_STYLE_MASK = 'mask';

    /** Drop span characters entirely. */
    public const REPLACE_STYLE_REMOVE = 'remove';

    public const ENTITY_PERSON = 'PERSON';
    public const ENTITY_EMAIL = 'EMAIL';
    public const ENTITY_PHONE = 'PHONE';
    public const ENTITY_LOCATION = 'LOCATION';
    public const ENTITY_FINANCIAL = 'FINANCIAL';
    public const ENTITY_SECRET = 'SECRET';

    private const MODES = [self::MODE_ACCURATE, self::MODE_AGGRESSIVE, self::MODE_FAST];

    private const REPLACE_STYLES = [self::REPLACE_STYLE_TAG, self::REPLACE_STYLE_MASK, self::REPLACE_STYLE_REMOVE];

    private const ENTITIES = [
        self::ENTITY_PERSON,
        self::ENTITY_EMAIL,
        self::ENTITY_PHONE,
        self::ENTITY_LOCATION,
        self::ENTITY_FINANCIAL,
        self::ENTITY_SECRET,
    ];

    /**
     * @param list<string>|null $entities Redaction entity kinds, for example RedactPIIOptions::ENTITY_EMAIL.
     *     Unset means every entity kind.
     */
    private function __construct(
        private readonly ?string $mode = null,
        /** @var list<string>|null */
        private readonly ?array $entities = null,
        private readonly ?string $replaceStyle = null,
    ) {}

    /**
     * @param string|null       $mode         MODE_ACCURATE, MODE_AGGRESSIVE, or MODE_FAST.
     * @param list<string>|null $entities     Redaction entity kinds. Unset means every entity kind.
     * @param string|null       $replaceStyle REPLACE_STYLE_TAG, REPLACE_STYLE_MASK, or REPLACE_STYLE_REMOVE.
     */
    public static function with(
        ?string $mode = null,
        ?array $entities = null,
        ?string $replaceStyle = null,
    ): self {
        if ($mode !== null && !in_array($mode, self::MODES, true)) {
            throw new \InvalidArgumentException("redactPII mode must be 'accurate', 'aggressive', or 'fast'");
        }

        if ($replaceStyle !== null && !in_array($replaceStyle, self::REPLACE_STYLES, true)) {
            throw new \InvalidArgumentException("redactPII replaceStyle must be 'tag', 'mask', or 'remove'");
        }

        foreach ($entities ?? [] as $entity) {
            if (!in_array($entity, self::ENTITIES, true)) {
                throw new \InvalidArgumentException(
                    'redactPII entity must be one of PERSON, EMAIL, PHONE, LOCATION, FINANCIAL, SECRET',
                );
            }
        }

        return new self($mode, $entities, $replaceStyle);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'mode' => $this->mode,
            'entities' => $this->entities,
            'replaceStyle' => $this->replaceStyle,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getMode(): ?string
    {
        return $this->mode;
    }

    /** @return list<string>|null */
    public function getEntities(): ?array
    {
        return $this->entities;
    }

    public function getReplaceStyle(): ?string
    {
        return $this->replaceStyle;
    }
}
