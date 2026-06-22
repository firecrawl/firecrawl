<?php

declare(strict_types=1);

namespace Firecrawl\Models;

use Firecrawl\Exceptions\FirecrawlException;

/**
 * Options for parsing uploaded files via `/v2/parse`.
 *
 * Parse does not support browser-rendering features (actions, waitFor,
 * location, mobile) nor the screenshot, branding, product, menu, audio, video, or changeTracking formats.
 * The proxy field only accepts "auto" or "basic".
 */
final class ParseOptions
{
    private const UNSUPPORTED_FORMATS = [
        'changeTracking',
        'screenshot',
        'screenshot@fullPage',
        'branding',
        'product',
        'menu',
        'audio',
        'video',
    ];

    /**
     * @param list<string|JsonFormat|QuestionFormat|HighlightsFormat|QueryFormat>|null $formats
     * @param array<string, string>|null   $headers
     * @param list<string>|null            $includeTags
     * @param list<string>|null            $excludeTags
     * @param list<mixed>|null             $parsers
     */
    private function __construct(
        private readonly ?array $formats = null,
        private readonly ?array $headers = null,
        private readonly ?array $includeTags = null,
        private readonly ?array $excludeTags = null,
        private readonly ?bool $onlyMainContent = null,
        private readonly ?int $timeout = null,
        private readonly ?array $parsers = null,
        private readonly ?bool $skipTlsVerification = null,
        private readonly ?bool $removeBase64Images = null,
        private readonly ?bool $blockAds = null,
        private readonly ?string $proxy = null,
        private readonly ?string $integration = null,
        private readonly ?bool $redactPII = null,
    ) {}

    /**
     * @param list<string|JsonFormat|QuestionFormat|HighlightsFormat|QueryFormat>|null $formats
     * @param array<string, string>|null   $headers
     * @param list<string>|null            $includeTags
     * @param list<string>|null            $excludeTags
     * @param list<mixed>|null             $parsers
     */
    public static function with(
        ?array $formats = null,
        ?array $headers = null,
        ?array $includeTags = null,
        ?array $excludeTags = null,
        ?bool $onlyMainContent = null,
        ?int $timeout = null,
        ?array $parsers = null,
        ?bool $skipTlsVerification = null,
        ?bool $removeBase64Images = null,
        ?bool $blockAds = null,
        ?string $proxy = null,
        ?string $integration = null,
        ?bool $redactPII = null,
    ): self {
        if ($timeout !== null && $timeout <= 0) {
            throw new FirecrawlException('timeout must be positive');
        }

        if ($proxy !== null && $proxy !== '' && !in_array($proxy, ['auto', 'basic'], true)) {
            throw new FirecrawlException("parse only supports proxy values 'auto' or 'basic'");
        }

        if ($formats !== null) {
            foreach ($formats as $fmt) {
                $type = self::extractFormatType($fmt);
                if ($type !== null && in_array($type, self::UNSUPPORTED_FORMATS, true)) {
                    throw new FirecrawlException('parse does not support format: ' . $type);
                }
            }
        }

        return new self(
            $formats,
            $headers,
            $includeTags,
            $excludeTags,
            $onlyMainContent,
            $timeout,
            $parsers,
            $skipTlsVerification,
            $removeBase64Images,
            $blockAds,
            $proxy,
            $integration,
            $redactPII,
        );
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        $data = [];

        if ($this->formats !== null) {
            $data['formats'] = array_map(
                fn (string|JsonFormat|QuestionFormat|HighlightsFormat|QueryFormat $f): string|array =>
                    (
                        $f instanceof JsonFormat
                        || $f instanceof QuestionFormat
                        || $f instanceof HighlightsFormat
                        || $f instanceof QueryFormat
                    ) ? $f->toArray() : $f,
                $this->formats,
            );
        }

        $fields = [
            'headers' => $this->headers,
            'includeTags' => $this->includeTags,
            'excludeTags' => $this->excludeTags,
            'onlyMainContent' => $this->onlyMainContent,
            'timeout' => $this->timeout,
            'parsers' => $this->parsers,
            'skipTlsVerification' => $this->skipTlsVerification,
            'removeBase64Images' => $this->removeBase64Images,
            'blockAds' => $this->blockAds,
            'proxy' => $this->proxy,
            'integration' => $this->integration,
            'redactPII' => $this->redactPII,
        ];

        foreach ($fields as $key => $value) {
            if ($value !== null) {
                $data[$key] = $value;
            }
        }

        return $data;
    }

    private static function extractFormatType(mixed $fmt): ?string
    {
        if (is_string($fmt)) {
            return $fmt;
        }
        if ($fmt instanceof JsonFormat) {
            return 'json';
        }
        if ($fmt instanceof QuestionFormat) {
            return 'question';
        }
        if ($fmt instanceof HighlightsFormat) {
            return 'highlights';
        }
        if ($fmt instanceof QueryFormat) {
            return 'query';
        }
        if (is_array($fmt) && isset($fmt['type']) && is_string($fmt['type'])) {
            return $fmt['type'];
        }
        return null;
    }

    /** @return list<string|JsonFormat|QuestionFormat|HighlightsFormat|QueryFormat>|null */
    public function getFormats(): ?array
    {
        return $this->formats;
    }

    /** @return array<string, string>|null */
    public function getHeaders(): ?array
    {
        return $this->headers;
    }

    /** @return list<string>|null */
    public function getIncludeTags(): ?array
    {
        return $this->includeTags;
    }

    /** @return list<string>|null */
    public function getExcludeTags(): ?array
    {
        return $this->excludeTags;
    }

    public function getOnlyMainContent(): ?bool
    {
        return $this->onlyMainContent;
    }

    public function getTimeout(): ?int
    {
        return $this->timeout;
    }

    /** @return list<mixed>|null */
    public function getParsers(): ?array
    {
        return $this->parsers;
    }

    public function getSkipTlsVerification(): ?bool
    {
        return $this->skipTlsVerification;
    }

    public function getRemoveBase64Images(): ?bool
    {
        return $this->removeBase64Images;
    }

    public function getBlockAds(): ?bool
    {
        return $this->blockAds;
    }

    public function getProxy(): ?string
    {
        return $this->proxy;
    }

    public function getIntegration(): ?string
    {
        return $this->integration;
    }
}
