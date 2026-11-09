<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class AgentListItem
{
    /**
     * @param array{hidden?: bool, starred?: bool, label?: string|null} $settings
     * @param array{urls?: list<string>, prompt?: string, schema?: mixed, model?: string, effort?: string}|null $options
     */
    public function __construct(
        private readonly ?string $id = null,
        private readonly ?string $createdAt = null,
        private readonly ?string $targetHint = null,
        private readonly ?string $origin = null,
        private readonly ?string $integration = null,
        private readonly array $settings = [],
        private readonly ?string $status = null,
        private readonly ?array $options = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        $settings = $data['settings'] ?? [];
        $options = $data['options'] ?? null;

        return new self(
            id: $data['id'] ?? null,
            createdAt: $data['createdAt'] ?? null,
            targetHint: $data['targetHint'] ?? null,
            origin: $data['origin'] ?? null,
            integration: $data['integration'] ?? null,
            settings: is_array($settings) ? $settings : [],
            status: $data['status'] ?? null,
            options: is_array($options) ? $options : null,
        );
    }

    public function getId(): ?string
    {
        return $this->id;
    }

    public function getCreatedAt(): ?string
    {
        return $this->createdAt;
    }

    public function getTargetHint(): ?string
    {
        return $this->targetHint;
    }

    public function getOrigin(): ?string
    {
        return $this->origin;
    }

    public function getIntegration(): ?string
    {
        return $this->integration;
    }

    /** @return array{hidden?: bool, starred?: bool, label?: string|null} */
    public function getSettings(): array
    {
        return $this->settings;
    }

    public function getStatus(): ?string
    {
        return $this->status;
    }

    /** @return array{urls?: list<string>, prompt?: string, schema?: mixed, model?: string, effort?: string}|null */
    public function getOptions(): ?array
    {
        return $this->options;
    }
}
