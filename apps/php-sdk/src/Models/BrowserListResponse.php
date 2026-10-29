<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BrowserListResponse
{
    /**
     * @param list<BrowserSession> $sessions
     */
    public function __construct(
        private readonly bool $success = false,
        private readonly array $sessions = [],
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $sessions = [];
        $rawSessions = $data['sessions'] ?? [];
        if (is_array($rawSessions)) {
            foreach ($rawSessions as $session) {
                $sessions[] = BrowserSession::fromArray($session);
            }
        }

        return new self(
            success: (bool) ($data['success'] ?? false),
            sessions: $sessions,
            error: $data['error'] ?? null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    /** @return list<BrowserSession> */
    public function getSessions(): array
    {
        return $this->sessions;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
