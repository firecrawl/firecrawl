<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * What an agent run did with Exchange. toolkits and requireApproval are what
 * the run resolved to after thread inheritance, not what the request sent.
 */
final class AgentExchangeSummary
{
    /**
     * @param list<string>               $toolkits
     * @param list<AgentSkippedProvider> $skippedProviders
     */
    public function __construct(
        private readonly bool $enabled = false,
        private readonly array $toolkits = [],
        private readonly ?bool $requireApproval = null,
        private readonly ?string $onTermsRequired = null,
        private readonly int $paidCalls = 0,
        private readonly ?int $creditsUsed = null,
        private readonly array $skippedProviders = [],
        private readonly ?AgentTermsRequiredAction $requiresAction = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $skippedProviders = [];
        if (isset($data['skippedProviders']) && is_array($data['skippedProviders'])) {
            foreach ($data['skippedProviders'] as $provider) {
                if (is_array($provider)) {
                    $skippedProviders[] = AgentSkippedProvider::fromArray($provider);
                }
            }
        }

        return new self(
            enabled: ($data['enabled'] ?? false) === true,
            toolkits: isset($data['toolkits']) && is_array($data['toolkits'])
                ? array_values($data['toolkits'])
                : [],
            requireApproval: is_bool($data['requireApproval'] ?? null) ? $data['requireApproval'] : null,
            onTermsRequired: $data['onTermsRequired'] ?? null,
            paidCalls: (int) ($data['paidCalls'] ?? 0),
            creditsUsed: isset($data['creditsUsed']) ? (int) $data['creditsUsed'] : null,
            skippedProviders: $skippedProviders,
            requiresAction: isset($data['requiresAction']) && is_array($data['requiresAction'])
                ? AgentTermsRequiredAction::fromArray($data['requiresAction'])
                : null,
        );
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    /** @return list<string> */
    public function getToolkits(): array
    {
        return $this->toolkits;
    }

    public function getRequireApproval(): ?bool
    {
        return $this->requireApproval;
    }

    /** "skip" or "ask". Null until terms gating is on for the thread. */
    public function getOnTermsRequired(): ?string
    {
        return $this->onTermsRequired;
    }

    public function getPaidCalls(): int
    {
        return $this->paidCalls;
    }

    public function getCreditsUsed(): ?int
    {
        return $this->creditsUsed;
    }

    /**
     * Providers that would have helped but were not used because their data
     * terms are not accepted.
     *
     * @return list<AgentSkippedProvider>
     */
    public function getSkippedProviders(): array
    {
        return $this->skippedProviders;
    }

    /** Set in "ask" mode when a terms offer ended the turn. */
    public function getRequiresAction(): ?AgentTermsRequiredAction
    {
        return $this->requiresAction;
    }
}
