<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class JsonFormat
{
    private function __construct(
        private readonly ?string $prompt = null,
        /** @var array<string, mixed>|null */
        private readonly ?array $schema = null,
        private readonly ?bool $checkPromptInjection = null,
    ) {}

    /**
     * @param array<string, mixed>|null $schema
     */
    public static function with(
        ?string $prompt = null,
        ?array $schema = null,
        ?bool $checkPromptInjection = null,
    ): self {
        return new self($prompt, $schema, $checkPromptInjection);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'type' => 'json',
            'prompt' => $this->prompt,
            'schema' => $this->schema,
            'checkPromptInjection' => $this->checkPromptInjection,
        ], fn (mixed $v): bool => $v !== null);
    }

    public function getPrompt(): ?string
    {
        return $this->prompt;
    }

    /** @return array<string, mixed>|null */
    public function getSchema(): ?array
    {
        return $this->schema;
    }

    public function getCheckPromptInjection(): ?bool
    {
        return $this->checkPromptInjection;
    }
}
