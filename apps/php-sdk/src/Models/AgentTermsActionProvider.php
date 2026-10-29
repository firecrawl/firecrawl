<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** A provider whose data terms the caller can view and accept. */
final class AgentTermsActionProvider
{
    /**
     * @param array<string, mixed>|null $show
     * @param array<string, mixed>|null $accept
     */
    public function __construct(
        private readonly ?string $provider = null,
        private readonly ?string $name = null,
        private readonly ?string $capability = null,
        private readonly ?string $adds = null,
        private readonly ?string $version = null,
        private readonly ?string $digest = null,
        private readonly ?string $url = null,
        private readonly ?array $show = null,
        private readonly ?array $accept = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            provider: $data['provider'] ?? null,
            name: $data['name'] ?? null,
            capability: $data['capability'] ?? null,
            adds: $data['adds'] ?? null,
            version: $data['version'] ?? null,
            digest: $data['digest'] ?? null,
            url: $data['url'] ?? null,
            show: isset($data['show']) && is_array($data['show']) ? $data['show'] : null,
            accept: isset($data['accept']) && is_array($data['accept']) ? $data['accept'] : null,
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

    /**
     * The terms/show call: {provider, capability, options}.
     *
     * @return array<string, mixed>|null
     */
    public function getShow(): ?array
    {
        return $this->show;
    }

    /**
     * The terms/accept call: {provider, capability, options}. Make it only
     * after the user has explicitly agreed to the terms.
     *
     * @return array<string, mixed>|null
     */
    public function getAccept(): ?array
    {
        return $this->accept;
    }
}
