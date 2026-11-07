<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** A provider listed in a "terms" pending approval. */
final class AgentTermsGate
{
    public function __construct(
        private readonly ?string $provider = null,
        private readonly ?string $name = null,
        private readonly ?string $logo = null,
        private readonly ?string $capability = null,
        private readonly ?string $adds = null,
        private readonly ?string $version = null,
        private readonly ?string $digest = null,
        private readonly ?string $url = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            provider: $data['provider'] ?? null,
            name: $data['name'] ?? null,
            logo: $data['logo'] ?? null,
            capability: $data['capability'] ?? null,
            adds: $data['adds'] ?? null,
            version: $data['version'] ?? null,
            digest: $data['digest'] ?? null,
            url: $data['url'] ?? null,
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

    public function getLogo(): ?string
    {
        return $this->logo;
    }

    public function getCapability(): ?string
    {
        return $this->capability;
    }

    /** What the provider would add, in the agent's words. */
    public function getAdds(): ?string
    {
        return $this->adds;
    }

    public function getVersion(): ?string
    {
        return $this->version;
    }

    /** Null when the catalog published no digest; terms/show returns it. */
    public function getDigest(): ?string
    {
        return $this->digest;
    }

    /** Where a person accepts the terms in the dashboard. */
    public function getUrl(): ?string
    {
        return $this->url;
    }
}
