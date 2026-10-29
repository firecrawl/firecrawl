<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** A paid call held back by a pending approval. */
final class AgentPendingApprovalCall
{
    /**
     * @param array<string, mixed>       $input
     * @param list<array<string, mixed>> $more
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $provider = null,
        private readonly ?string $capability = null,
        private readonly array $input = [],
        private readonly array $more = [],
        private readonly ?int $creditsEstimate = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? null,
            provider: $data['provider'] ?? null,
            capability: $data['capability'] ?? null,
            input: isset($data['input']) && is_array($data['input']) ? $data['input'] : [],
            more: isset($data['more']) && is_array($data['more'])
                ? array_values(array_filter($data['more'], 'is_array'))
                : [],
            creditsEstimate: isset($data['creditsEstimate']) ? (int) $data['creditsEstimate'] : null,
        );
    }

    /** Pass in the approval's callIds to approve only some calls. */
    public function getId(): ?string
    {
        return $this->id;
    }

    public function getProvider(): ?string
    {
        return $this->provider;
    }

    public function getCapability(): ?string
    {
        return $this->capability;
    }

    /** @return array<string, mixed> */
    public function getInput(): array
    {
        return $this->input;
    }

    /**
     * Further inputs batched into this call. creditsEstimate covers them too.
     *
     * @return list<array<string, mixed>>
     */
    public function getMore(): array
    {
        return $this->more;
    }

    /** Null when the provider lists no per-call price. */
    public function getCreditsEstimate(): ?int
    {
        return $this->creditsEstimate;
    }
}
