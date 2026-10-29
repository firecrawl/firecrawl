<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BatchScrapeJob
{
    /** @var list<Document> */
    private array $data;

    /**
     * @param list<Document> $data
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $status = null,
        private readonly int $completed = 0,
        private readonly int $total = 0,
        private readonly ?int $creditsUsed = null,
        private readonly ?string $expiresAt = null,
        private ?string $next = null,
        array $data = [],
    ) {
        $this->data = $data;
    }

    /** @param array<string, mixed> $raw */
    public static function fromArray(array $raw): self
    {
        $docs = [];
        foreach (($raw['data'] ?? []) as $item) {
            $docs[] = Document::fromArray($item);
        }

        return new self(
            id: $raw['id'] ?? null,
            status: $raw['status'] ?? null,
            completed: (int) ($raw['completed'] ?? 0),
            total: (int) ($raw['total'] ?? 0),
            creditsUsed: isset($raw['creditsUsed']) ? (int) $raw['creditsUsed'] : null,
            expiresAt: $raw['expiresAt'] ?? null,
            next: $raw['next'] ?? null,
            data: $docs,
        );
    }

    public function isDone(): bool
    {
        return in_array($this->status, ['completed', 'failed', 'cancelled'], true);
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getStatus(): ?string
    {
        return $this->status;
    }

    public function getCompleted(): int
    {
        return $this->completed;
    }

    public function getTotal(): int
    {
        return $this->total;
    }

    public function getCreditsUsed(): ?int
    {
        return $this->creditsUsed;
    }

    public function getExpiresAt(): ?string
    {
        return $this->expiresAt;
    }

    public function getNext(): ?string
    {
        return $this->next;
    }

    public function setNext(?string $next): void
    {
        $this->next = $next;
    }

    /** @return list<Document> */
    public function getData(): array
    {
        return $this->data;
    }

    /** @param list<Document> $data */
    public function setData(array $data): void
    {
        $this->data = $data;
    }

    public function appendData(Document $document): void
    {
        $this->data[] = $document;
    }
}
