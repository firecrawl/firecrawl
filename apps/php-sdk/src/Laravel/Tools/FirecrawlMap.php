<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Models\MapOptions;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Ai\Tools\Request;

class FirecrawlMap extends FirecrawlTool
{
    public function name(): string
    {
        return 'firecrawl_map';
    }

    public function description(): string
    {
        return 'Map a website with Firecrawl to discover the URLs it contains, returned as a JSON '
            . 'array of {url, title} objects. Use this to find pages on a specific site, optionally '
            . 'filtered by a search term, before scraping or crawling them.';
    }

    public function handle(Request $request): string
    {
        return $this->guard(function () use ($request): string {
            $limit = min(max($request->integer('limit') ?: 100, 1), 500);
            $search = (string) $request->string('search');

            $map = $this->client()->map(
                (string) $request->string('url'),
                MapOptions::with(
                    search: $search !== '' ? $search : null,
                    limit: $limit,
                    integration: self::INTEGRATION,
                ),
            );

            $links = array_map(static function (array $link): array {
                return array_filter(
                    ['url' => $link['url'] ?? null, 'title' => $link['title'] ?? null],
                    static fn (mixed $value): bool => $value !== null,
                );
            }, $map->getLinks());

            if ($links === []) {
                return 'No URLs discovered.';
            }

            return $this->toBudgetedJson($links);
        });
    }

    /** @return array<string, \Illuminate\JsonSchema\Types\Type> */
    public function schema(JsonSchema $schema): array
    {
        return [
            'url' => $schema->string()
                ->description('The base URL of the website to map (e.g. https://example.com).')
                ->required(),
            'search' => $schema->string()
                ->description('Optional term to filter the discovered URLs by relevance (e.g. "docs").'),
            'limit' => $schema->integer()->min(1)->max(500)
                ->description('Maximum number of URLs to return. Defaults to 100.'),
        ];
    }
}
