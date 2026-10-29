<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** A provider the run would have used but skipped because its data terms are not accepted. */
final class AgentSkippedProvider
{
    public function __construct(
        private readonly ?string $provider = null,
        private readonly ?string $name = null,
        private readonly ?string $capability = null,
        private readonly ?string $adds = null,
        private readonly ?string $reason = null,
        private readonly ?string $version = null,
        private readonly ?string $termsUrl = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            provider: $data['provider'] ?? null,
            name: $data['name'] ?? null,
            capability: $data['capability'] ?? null,
            adds: $data['adds'] ?? null,
            reason: $data['reason'] ?? null,
            version: $data['version'] ?? null,
            termsUrl: $data['termsUrl'] ?? null,
        );
    }

    public function getProvider(): ?string
    {
        return $this->provider;
    }

    public function getName(): ?string
    {
        return $this->name;
    }

    public function getCapability(): ?string
    {
        return $this->capability;
    }

    /** What the provider would have added, in the agent's words. */
    public function getAdds(): ?string
    {
        return $this->adds;
    }

    /** "terms_required". */
    public function getReason(): ?string
    {
        return $this->reason;
    }

    /** The version of the terms that gate the provider. */
    public function getVersion(): ?string
    {
        return $this->version;
    }

    /** Where a person accepts the terms in the dashboard. */
    public function getTermsUrl(): ?string
    {
        return $this->termsUrl;
    }
}
