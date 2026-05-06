<?php

declare(strict_types=1);

namespace Firecrawl\Models;

/** @phpstan-consistent-constructor */
class MonitorCheck
{
    /**
     * @param array<string, mixed>      $summary
     * @param mixed                     $targetResults
     * @param mixed                     $notificationStatus
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $monitorId = null,
        private readonly ?string $status = null,
        private readonly ?string $trigger = null,
        private readonly ?string $scheduledFor = null,
        private readonly ?string $startedAt = null,
        private readonly ?string $finishedAt = null,
        private readonly ?int $estimatedCredits = null,
        private readonly ?int $reservedCredits = null,
        private readonly ?int $actualCredits = null,
        private readonly ?string $billingStatus = null,
        private readonly array $summary = [],
        private readonly mixed $targetResults = null,
        private readonly mixed $notificationStatus = null,
        private readonly ?string $error = null,
        private readonly ?string $createdAt = null,
        private readonly ?string $updatedAt = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): static
    {
        return new static(
            id: isset($data['id']) ? (string) $data['id'] : null,
            monitorId: isset($data['monitorId']) ? (string) $data['monitorId'] : null,
            status: isset($data['status']) ? (string) $data['status'] : null,
            trigger: isset($data['trigger']) ? (string) $data['trigger'] : null,
            scheduledFor: isset($data['scheduledFor']) ? (string) $data['scheduledFor'] : null,
            startedAt: isset($data['startedAt']) ? (string) $data['startedAt'] : null,
            finishedAt: isset($data['finishedAt']) ? (string) $data['finishedAt'] : null,
            estimatedCredits: isset($data['estimatedCredits']) ? (int) $data['estimatedCredits'] : null,
            reservedCredits: isset($data['reservedCredits']) ? (int) $data['reservedCredits'] : null,
            actualCredits: isset($data['actualCredits']) ? (int) $data['actualCredits'] : null,
            billingStatus: isset($data['billingStatus']) ? (string) $data['billingStatus'] : null,
            summary: isset($data['summary']) && is_array($data['summary']) ? $data['summary'] : [],
            targetResults: $data['targetResults'] ?? null,
            notificationStatus: $data['notificationStatus'] ?? null,
            error: isset($data['error']) ? (string) $data['error'] : null,
            createdAt: isset($data['createdAt']) ? (string) $data['createdAt'] : null,
            updatedAt: isset($data['updatedAt']) ? (string) $data['updatedAt'] : null,
        );
    }

    public function getId(): ?string { return $this->id; }
    public function getMonitorId(): ?string { return $this->monitorId; }
    public function getStatus(): ?string { return $this->status; }
    public function getTrigger(): ?string { return $this->trigger; }
    public function getScheduledFor(): ?string { return $this->scheduledFor; }
    public function getStartedAt(): ?string { return $this->startedAt; }
    public function getFinishedAt(): ?string { return $this->finishedAt; }
    public function getEstimatedCredits(): ?int { return $this->estimatedCredits; }
    public function getReservedCredits(): ?int { return $this->reservedCredits; }
    public function getActualCredits(): ?int { return $this->actualCredits; }
    public function getBillingStatus(): ?string { return $this->billingStatus; }
    /** @return array<string, mixed> */
    public function getSummary(): array { return $this->summary; }
    public function getTargetResults(): mixed { return $this->targetResults; }
    public function getNotificationStatus(): mixed { return $this->notificationStatus; }
    public function getError(): ?string { return $this->error; }
    public function getCreatedAt(): ?string { return $this->createdAt; }
    public function getUpdatedAt(): ?string { return $this->updatedAt; }
}
