<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/**
 * A turn that ended waiting for the caller. Kind "calls" holds paid calls to
 * approve or decline; kind "terms" lists providers whose data terms need
 * accepting, and its calls are always empty.
 */
final class AgentPendingApproval
{
    /**
     * @param list<AgentPendingApprovalCall> $calls
     * @param list<AgentTermsGate>           $terms
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly string $kind = 'calls',
        private readonly ?string $reason = null,
        private readonly array $calls = [],
        private readonly array $terms = [],
        private readonly ?AgentPendingApprovalResolution $resolution = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $calls = [];
        if (isset($data['calls']) && is_array($data['calls'])) {
            foreach ($data['calls'] as $call) {
                if (is_array($call)) {
                    $calls[] = AgentPendingApprovalCall::fromArray($call);
                }
            }
        }

        $terms = [];
        if (isset($data['terms']) && is_array($data['terms'])) {
            foreach ($data['terms'] as $gate) {
                if (is_array($gate)) {
                    $terms[] = AgentTermsGate::fromArray($gate);
                }
            }
        }

        return new self(
            id: $data['id'] ?? null,
            // Approvals written before terms offers existed carry no kind.
            kind: $data['kind'] ?? 'calls',
            reason: $data['reason'] ?? null,
            calls: $calls,
            terms: $terms,
            resolution: isset($data['resolution']) && is_array($data['resolution'])
                ? AgentPendingApprovalResolution::fromArray($data['resolution'])
                : null,
        );
    }

    /** Pass this as the approvalId to approve or decline on the next turn. */
    public function getId(): ?string
    {
        return $this->id;
    }

    /** "calls" or "terms". */
    public function getKind(): string
    {
        return $this->kind;
    }

    public function getReason(): ?string
    {
        return $this->reason;
    }

    /** @return list<AgentPendingApprovalCall> */
    public function getCalls(): array
    {
        return $this->calls;
    }

    /** @return list<AgentTermsGate> */
    public function getTerms(): array
    {
        return $this->terms;
    }

    /** Null until a later turn approves or declines it. */
    public function getResolution(): ?AgentPendingApprovalResolution
    {
        return $this->resolution;
    }
}
