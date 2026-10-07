<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentOptions
{
    /**
     * @param list<string>|null          $urls
     * @param array<string, mixed>|null  $schema
     * @param string|null                $effort Reasoning budget: "low", "medium",
     *        or "high". Every level runs spark-2.
     * @param AuditMetadata|null         $auditMetadata
     * @param string|null                $threadId Continue this thread as its next
     *        turn. Omitted starts a new thread.
     * @param string|null                $mode "extract" or "chat".
     */
    private function __construct(
        private readonly ?array $urls = null,
        private readonly ?string $prompt = null,
        private readonly ?array $schema = null,
        private readonly ?string $integration = null,
        private readonly ?int $maxCredits = null,
        private readonly ?bool $strictConstrainToURLs = null,
        private readonly ?string $model = null,
        private readonly ?string $effort = null,
        private readonly ?WebhookConfig $webhook = null,
        private readonly ?AuditMetadata $auditMetadata = null,
        private readonly ?string $threadId = null,
        private readonly ?string $mode = null,
        private readonly ?AgentExchangeOptions $exchange = null,
    ) {}

    /**
     * @param list<string>|null         $urls
     * @param array<string, mixed>|null $schema
     * @param string|null                $effort Reasoning budget: "low", "medium",
     *        or "high". Every level runs spark-2.
     * @param AuditMetadata|null         $auditMetadata
     * @param string|null                $threadId Continue this thread as its next
     *        turn. Omitted starts a new thread.
     * @param string|null                $mode "extract" or "chat".
     */
    public static function with(
        ?array $urls = null,
        ?string $prompt = null,
        ?array $schema = null,
        ?string $integration = null,
        ?int $maxCredits = null,
        ?bool $strictConstrainToURLs = null,
        ?string $model = null,
        ?string $effort = null,
        ?WebhookConfig $webhook = null,
        ?AuditMetadata $auditMetadata = null,
        ?string $threadId = null,
        ?string $mode = null,
        ?AgentExchangeOptions $exchange = null,
    ): self {
        return new self(
            $urls, $prompt, $schema, $integration,
            $maxCredits, $strictConstrainToURLs, $model, $effort, $webhook, $auditMetadata,
            $threadId, $mode, $exchange,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $fields = [
            'urls' => $this->urls,
            'prompt' => $this->prompt,
            'schema' => $this->schema,
            'integration' => $this->integration,
            'maxCredits' => $this->maxCredits,
            'strictConstrainToURLs' => $this->strictConstrainToURLs,
            'model' => $this->model,
            'effort' => $this->effort,
            'webhook' => $this->webhook?->toArray(),
            'auditMetadata' => $this->auditMetadata?->toArray(),
            'threadId' => $this->threadId,
            'mode' => $this->mode,
            // An empty exchange still turns Exchange on, so it must encode as {} rather than [].
            'exchange' => $this->exchange === null ? null : (object) $this->exchange->toArray(),
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
