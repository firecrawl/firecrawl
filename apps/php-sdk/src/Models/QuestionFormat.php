<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class QuestionFormat
{
    private function __construct(
        private readonly string $question,
    ) {}

    public static function with(string $question): self
    {
        return new self($question);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'type' => 'question',
            'question' => $this->question,
        ];
    }

    public function getQuestion(): string
    {
        return $this->question;
    }
}
