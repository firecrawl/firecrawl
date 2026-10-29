<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class MonitorCheckDetail extends MonitorCheck
{
    /**
     * @param list<array<string, mixed>> $pages Each page array contains
     *     keys: id, targetId, url, status, previousScrapeId,
     *     currentScrapeId, statusCode, error, metadata, diff, snapshot,
     *     judgment, createdAt. The `diff` value (when present) is an
     *     array with `text` (markdown unified diff) and/or `json`
     *     (parseDiff AST for markdown monitors, or a per-field
     *     `{previous, current}` map for JSON-extraction monitors). The
     *     `snapshot` value (JSON / mixed mode only) is an array with a
     *     `json` key holding the current JSON extraction at this run.
     *     The `judgment` value (present when the monitor has a `goal`
     *     set and judging is enabled) is an array with `meaningful`
     *     (bool), `confidence` (`high`|`medium`|`low`), `reason`
     *     (string), and `fields` (list of strings).
     */
    public function __construct(
        ?string $id = null,
        ?string $monitorId = null,
        ?string $status = null,
        ?string $trigger = null,
        ?string $scheduledFor = null,
        ?string $startedAt = null,
        ?string $finishedAt = null,
        ?int $estimatedCredits = null,
        ?int $reservedCredits = null,
        ?int $actualCredits = null,
        ?string $billingStatus = null,
        array $summary = [],
        mixed $targetResults = null,
        mixed $notificationStatus = null,
        ?string $error = null,
        ?string $createdAt = null,
        ?string $updatedAt = null,
        private readonly array $pages = [],
        private readonly ?string $next = null,
    ) {
        parent::__construct(
            id: $id,
            monitorId: $monitorId,
            status: $status,
            trigger: $trigger,
            scheduledFor: $scheduledFor,
            startedAt: $startedAt,
            finishedAt: $finishedAt,
            estimatedCredits: $estimatedCredits,
            reservedCredits: $reservedCredits,
            actualCredits: $actualCredits,
            billingStatus: $billingStatus,
            summary: $summary,
            targetResults: $targetResults,
            notificationStatus: $notificationStatus,
            error: $error,
            createdAt: $createdAt,
            updatedAt: $updatedAt,
        );
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): static
    {
        /** @var self $check */
        $check = new self(
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
            pages: isset($data['pages']) && is_array($data['pages']) ? $data['pages'] : [],
            next: isset($data['next']) ? (string) $data['next'] : null,
        );

        return $check;
    }

    /**
     * @return list<array<string, mixed>> Each page array contains the
     *     standard monitor page fields plus the `diff` and `snapshot`
     *     payloads when present. See the constructor PHPDoc for the
     *     shape of those nested values.
     */
    public function getPages(): array { return $this->pages; }
    public function getNext(): ?string { return $this->next; }
}
