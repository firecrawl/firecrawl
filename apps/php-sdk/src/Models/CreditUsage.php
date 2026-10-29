<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class CreditUsage
{
    public function __construct(
        private readonly int $remainingCredits = 0,
        private readonly ?int $planCredits = null,
        private readonly ?string $billingPeriodStart = null,
        private readonly ?string $billingPeriodEnd = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $inner = $data['data'] ?? $data;

        return new self(
            remainingCredits: (int) ($inner['remainingCredits'] ?? 0),
            planCredits: isset($inner['planCredits']) ? (int) $inner['planCredits'] : null,
            billingPeriodStart: $inner['billingPeriodStart'] ?? null,
            billingPeriodEnd: $inner['billingPeriodEnd'] ?? null,
        );
    }

    public function getRemainingCredits(): int
    {
        return $this->remainingCredits;
    }

    public function getPlanCredits(): ?int
    {
        return $this->planCredits;
    }

    public function getBillingPeriodStart(): ?string
    {
        return $this->billingPeriodStart;
    }

    public function getBillingPeriodEnd(): ?string
    {
        return $this->billingPeriodEnd;
    }
}
