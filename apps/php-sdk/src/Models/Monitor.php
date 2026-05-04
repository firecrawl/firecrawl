<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class Monitor
{
    /**
     * @param list<array<string, mixed>> $targets
     * @param array<string, mixed>|null  $schedule
     * @param array<string, mixed>|null  $webhook
     * @param array<string, mixed>|null  $notification
     * @param array<string, mixed>|null  $lastCheckSummary
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $name = null,
        private readonly ?string $status = null,
        private readonly ?array $schedule = null,
        private readonly ?string $nextRunAt = null,
        private readonly ?string $lastRunAt = null,
        private readonly ?string $currentCheckId = null,
        private readonly array $targets = [],
        private readonly ?array $webhook = null,
        private readonly ?array $notification = null,
        private readonly ?int $retentionDays = null,
        private readonly ?int $estimatedCreditsPerMonth = null,
        private readonly ?array $lastCheckSummary = null,
        private readonly ?string $createdAt = null,
        private readonly ?string $updatedAt = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: isset($data['id']) ? (string) $data['id'] : null,
            name: isset($data['name']) ? (string) $data['name'] : null,
            status: isset($data['status']) ? (string) $data['status'] : null,
            schedule: isset($data['schedule']) && is_array($data['schedule']) ? $data['schedule'] : null,
            nextRunAt: isset($data['nextRunAt']) ? (string) $data['nextRunAt'] : null,
            lastRunAt: isset($data['lastRunAt']) ? (string) $data['lastRunAt'] : null,
            currentCheckId: isset($data['currentCheckId']) ? (string) $data['currentCheckId'] : null,
            targets: isset($data['targets']) && is_array($data['targets']) ? $data['targets'] : [],
            webhook: isset($data['webhook']) && is_array($data['webhook']) ? $data['webhook'] : null,
            notification: isset($data['notification']) && is_array($data['notification']) ? $data['notification'] : null,
            retentionDays: isset($data['retentionDays']) ? (int) $data['retentionDays'] : null,
            estimatedCreditsPerMonth: isset($data['estimatedCreditsPerMonth']) ? (int) $data['estimatedCreditsPerMonth'] : null,
            lastCheckSummary: isset($data['lastCheckSummary']) && is_array($data['lastCheckSummary']) ? $data['lastCheckSummary'] : null,
            createdAt: isset($data['createdAt']) ? (string) $data['createdAt'] : null,
            updatedAt: isset($data['updatedAt']) ? (string) $data['updatedAt'] : null,
        );
    }

    public function getId(): ?string { return $this->id; }
    public function getName(): ?string { return $this->name; }
    public function getStatus(): ?string { return $this->status; }
    /** @return array<string, mixed>|null */
    public function getSchedule(): ?array { return $this->schedule; }
    public function getNextRunAt(): ?string { return $this->nextRunAt; }
    public function getLastRunAt(): ?string { return $this->lastRunAt; }
    public function getCurrentCheckId(): ?string { return $this->currentCheckId; }
    /** @return list<array<string, mixed>> */
    public function getTargets(): array { return $this->targets; }
    /** @return array<string, mixed>|null */
    public function getWebhook(): ?array { return $this->webhook; }
    /** @return array<string, mixed>|null */
    public function getNotification(): ?array { return $this->notification; }
    public function getRetentionDays(): ?int { return $this->retentionDays; }
    public function getEstimatedCreditsPerMonth(): ?int { return $this->estimatedCreditsPerMonth; }
    /** @return array<string, mixed>|null */
    public function getLastCheckSummary(): ?array { return $this->lastCheckSummary; }
    public function getCreatedAt(): ?string { return $this->createdAt; }
    public function getUpdatedAt(): ?string { return $this->updatedAt; }
}
