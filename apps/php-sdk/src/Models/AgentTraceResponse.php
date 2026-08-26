<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentTraceResponse
{
    /**
     * @param list<AgentTraceEvent>                $events
     * @param list<AgentTraceActiveBrowserSession> $activeBrowserSessions
     */
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $id = null,
        private readonly array $events = [],
        private readonly ?int $creditsUsed = null,
        private readonly array $activeBrowserSessions = [],
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $events = [];
        if (isset($data['events']) && is_array($data['events'])) {
            foreach ($data['events'] as $event) {
                if (is_array($event)) {
                    $events[] = AgentTraceEvent::fromArray($event);
                }
            }
        }

        $activeBrowserSessions = [];
        if (isset($data['activeBrowserSessions']) && is_array($data['activeBrowserSessions'])) {
            foreach ($data['activeBrowserSessions'] as $session) {
                if (is_array($session)) {
                    $activeBrowserSessions[] = AgentTraceActiveBrowserSession::fromArray($session);
                }
            }
        }

        return new self(
            success: (bool) ($data['success'] ?? false),
            id: $data['id'] ?? null,
            events: $events,
            creditsUsed: isset($data['creditsUsed']) ? (int) $data['creditsUsed'] : null,
            activeBrowserSessions: $activeBrowserSessions,
            error: $data['error'] ?? null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    /** @return list<AgentTraceEvent> */
    public function getEvents(): array
    {
        return $this->events;
    }

    public function getCreditsUsed(): ?int
    {
        return $this->creditsUsed;
    }

    /** @return list<AgentTraceActiveBrowserSession> */
    public function getActiveBrowserSessions(): array
    {
        return $this->activeBrowserSessions;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
