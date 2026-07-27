<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentOptions
{
    /**
     * @param list<string>|null          $urls
     * @param array<string, mixed>|null  $schema
     * @param array<string, string>|null $auditMetadata
     */
    private function __construct(
        private readonly ?array $urls = null,
        private readonly ?string $prompt = null,
        private readonly ?array $schema = null,
        private readonly ?string $integration = null,
        private readonly ?int $maxCredits = null,
        private readonly ?bool $strictConstrainToURLs = null,
        private readonly ?string $model = null,
        private readonly ?WebhookConfig $webhook = null,
        /** @var array<string, string>|null */
        private readonly ?array $auditMetadata = null,
    ) {}

    /**
     * @param list<string>|null         $urls
     * @param array<string, mixed>|null $schema
     * @param array<string, string>|null $auditMetadata
     */
    public static function with(
        ?array $urls = null,
        ?string $prompt = null,
        ?array $schema = null,
        ?string $integration = null,
        ?int $maxCredits = null,
        ?bool $strictConstrainToURLs = null,
        ?string $model = null,
        ?WebhookConfig $webhook = null,
        ?array $auditMetadata = null,
    ): self {
        return new self(
            $urls, $prompt, $schema, $integration,
            $maxCredits, $strictConstrainToURLs, $model, $webhook, $auditMetadata,
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
            'webhook' => $this->webhook?->toArray(),
            'auditMetadata' => $this->auditMetadata,
        ];

        return array_filter($fields, fn (mixed $v): bool => $v !== null);
    }
}
