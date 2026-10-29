<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** @deprecated Use QuestionFormat or HighlightsFormat instead. */
final class QueryFormat
{
    public const MODE_FREEFORM = 'freeform';
    public const MODE_DIRECT_QUOTE = 'directQuote';

    private function __construct(
        private readonly string $prompt,
        private readonly ?string $mode = null,
    ) {}

    public static function with(
        string $prompt,
        ?string $mode = null,
    ): self {
        if ($mode !== null && !in_array($mode, [self::MODE_FREEFORM, self::MODE_DIRECT_QUOTE], true)) {
            throw new \InvalidArgumentException("query mode must be 'freeform' or 'directQuote'");
        }

        return new self($prompt, $mode);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'type' => 'query',
            'prompt' => $this->prompt,
            'mode' => $this->mode,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getPrompt(): string
    {
        return $this->prompt;
    }

    public function getMode(): ?string
    {
        return $this->mode;
    }
}
