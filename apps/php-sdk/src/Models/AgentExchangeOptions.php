<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * Exchange (data provider) settings for an agent run. Sent as-is; the server
 * owns every default and limit. On a follow-up turn, omitting it inherits the
 * previous turn's settings.
 */
final class AgentExchangeOptions
{
    /** @param list<string>|null $toolkits */
    private function __construct(
        private readonly ?bool $enabled = null,
        private readonly ?array $toolkits = null,
        private readonly ?int $maxCalls = null,
        private readonly ?bool $requireApproval = null,
        private readonly ?AgentExchangeApproval $approve = null,
        private readonly ?AgentExchangeDecline $decline = null,
        private readonly ?string $onTermsRequired = null,
    ) {}

    /**
     * @param list<string>|null $toolkits        Provider slugs to pin. Omitted or
     *        empty means every provider the team can use.
     * @param bool|null         $requireApproval Needs mode "chat" on the request.
     * @param string|null       $onTermsRequired "skip" or "ask".
     */
    public static function with(
        ?bool $enabled = null,
        ?array $toolkits = null,
        ?int $maxCalls = null,
        ?bool $requireApproval = null,
        ?AgentExchangeApproval $approve = null,
        ?AgentExchangeDecline $decline = null,
        ?string $onTermsRequired = null,
    ): self {
        return new self($enabled, $toolkits, $maxCalls, $requireApproval, $approve, $decline, $onTermsRequired);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter([
            'enabled' => $this->enabled,
            'toolkits' => $this->toolkits,
            'maxCalls' => $this->maxCalls,
            'requireApproval' => $this->requireApproval,
            'approve' => $this->approve?->toArray(),
            'decline' => $this->decline?->toArray(),
            'onTermsRequired' => $this->onTermsRequired,
        ], fn (mixed $v): bool => $v !== null);
    }
}
