<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AuditMetadata
{
    private function __construct(
        private readonly string $username,
    ) {}

    public static function with(string $username): self
    {
        return new self($username);
    }

    /** @return array{username: string} */
    public function toArray(): array
    {
        return ['username' => $this->username];
    }

    public function getUsername(): string
    {
        return $this->username;
    }
}
