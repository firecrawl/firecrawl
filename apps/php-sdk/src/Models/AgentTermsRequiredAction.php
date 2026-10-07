<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * The Exchange calls to view and accept providers' data terms. Nothing here is
 * run for you: call terms/accept only after the user has explicitly agreed,
 * then continue the thread approving approvalId, or decline it.
 */
final class AgentTermsRequiredAction
{
    /** @param list<AgentTermsActionProvider> $providers */
    public function __construct(
        private readonly ?string $type = null,
        private readonly ?string $approvalId = null,
        private readonly array $providers = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $providers = [];
        if (isset($data['providers']) && is_array($data['providers'])) {
            foreach ($data['providers'] as $provider) {
                if (is_array($provider)) {
                    $providers[] = AgentTermsActionProvider::fromArray($provider);
                }
            }
        }

        return new self(
            type: $data['type'] ?? null,
            approvalId: $data['approvalId'] ?? null,
            providers: $providers,
        );
    }

    /** "accept_terms". */
    public function getType(): ?string
    {
        return $this->type;
    }

    /** The ID of the "terms" pending approval that answers this. */
    public function getApprovalId(): ?string
    {
        return $this->approvalId;
    }

    /** @return list<AgentTermsActionProvider> */
    public function getProviders(): array
    {
        return $this->providers;
    }
}
