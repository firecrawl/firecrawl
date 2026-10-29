<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Models\SearchOptions;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Ai\Tools\Request;

class FirecrawlSearch extends FirecrawlTool
{
    public function name(): string
    {
        return 'firecrawl_search';
    }

    public function description(): string
    {
        return 'Search the web with Firecrawl and return matching results as a JSON array of '
            . '{title, url, description} objects. Use this to find relevant pages when you do not '
            . 'already know the URL. Follow up with firecrawl_scrape to read the full content of a result.';
    }

    public function handle(Request $request): string
    {
        return $this->guard(function () use ($request): string {
            $limit = min(max($request->integer('limit') ?: 5, 1), 20);

            $results = $this->client()->search(
                (string) $request->string('query'),
                SearchOptions::with(limit: $limit, integration: self::INTEGRATION),
            );

            $web = array_map(static fn (array $item): array => [
                'title' => $item['title'] ?? null,
                'url' => $item['url'] ?? null,
                'description' => $item['description'] ?? null,
            ], $results->getWeb());

            if ($web === []) {
                return 'No results found.';
            }

            return $this->toBudgetedJson($web);
        });
    }

    /** @return array<string, \Illuminate\JsonSchema\Types\Type> */
    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()
                ->description('The search query.')
                ->required(),
            'limit' => $schema->integer()->min(1)->max(20)
                ->description('Maximum number of results to return. Defaults to 5.'),
        ];
    }
}
