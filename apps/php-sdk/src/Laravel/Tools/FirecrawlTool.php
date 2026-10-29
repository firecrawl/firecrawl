<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Client\FirecrawlClient;
use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\Document;
use Illuminate\Container\Container;
use Laravel\Ai\Contracts\Tool;

abstract class FirecrawlTool implements Tool
{
    // The underscore prefix passes the API's integration validator on every
    // deployed version, including older self-hosted instances.
    protected const INTEGRATION = '_laravel-ai';

    /** Whole-result output ceiling; override to change. */
    protected int $outputCharacterBudget = 100000;

    public function __construct(
        private ?FirecrawlClient $client = null,
    ) {}

    protected function client(): FirecrawlClient
    {
        if ($this->client === null) {
            /** @var FirecrawlClient $resolved */
            $resolved = Container::getInstance()->make(FirecrawlClient::class);
            $this->client = $resolved;
        }

        return $this->client;
    }

    /**
     * Convert any failure into a readable string so `handle()` never throws
     * and aborts the agent run.
     *
     * @param callable(): string $callback
     */
    protected function guard(callable $callback): string
    {
        try {
            return $callback();
        } catch (FirecrawlException $exception) {
            return 'Firecrawl request failed: ' . $exception->getMessage();
        } catch (\Throwable $exception) {
            return 'Tool execution failed: ' . $exception->getMessage();
        }
    }

    /**
     * Drop tail items when the JSON would exceed the output budget; a final
     * {"omitted": N} element reports the cut.
     *
     * @param list<array<string, mixed>> $items
     */
    protected function toBudgetedJson(array $items): string
    {
        $json = $this->toJson($items);
        $total = count($items);

        while (mb_strlen($json) > $this->outputCharacterBudget && count($items) > 1) {
            $items = array_slice($items, 0, (int) ceil(count($items) / 2));
            $json = $this->toJson([...$items, ['omitted' => $total - count($items)]]);
        }

        if (mb_strlen($json) > $this->outputCharacterBudget) {
            $json = $this->toJson([['omitted' => $total]]);
        }

        return $json;
    }

    /** @param array<int|string, mixed> $data */
    protected function toJson(array $data): string
    {
        return json_encode(
            $data,
            JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR,
        );
    }

    protected function documentContent(Document $document): string
    {
        $content = $document->getMarkdown()
            ?? $document->getSummary()
            ?? $document->getHtml()
            ?? '';

        if ($content === '') {
            return 'No content was returned for this page.';
        }

        $warning = $document->getWarning();

        return $warning !== null ? "Warning: {$warning}\n\n{$content}" : $content;
    }

    /**
     * Trim tool output so large pages do not overflow the model context.
     * The truncation notice fits inside the cap.
     */
    protected function truncate(string $content, int $maxCharacters): string
    {
        if (mb_strlen($content) <= $maxCharacters) {
            return $content;
        }

        $total = mb_strlen($content);
        $suffix = "\n\n[Truncated: {$total} characters total.]";

        if ($maxCharacters <= mb_strlen($suffix)) {
            return mb_substr($content, 0, $maxCharacters);
        }

        return mb_substr($content, 0, $maxCharacters - mb_strlen($suffix)) . $suffix;
    }
}
